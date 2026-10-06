import {
  playerOverall,
  type AttributeAxis,
  type SquadStatus,
  type Foot,
  type InjuryHistory,
  ATTRIBUTE_AXES,
  type AxisValues,
  ageOf,
  capsOf,
  internationalGoalsOf,
  naturalPositionOf,
  seasonRating,
  competitionRowsOf,
  type GamePlayer,
  rolesFor,
  defaultRoleOf,
  fatigueOf,
  observedFit,
  observedOverall,
  type GrowthOutlook,
} from "@gaffer/domain";
import {
  type RecentRatingView,
  type SquadViewRow,
  type MilestoneView,
  type SquadPositionView,
  recentRatingsOf,
  awayViewOf,
  SQUAD_MILESTONES_SHOWN,
} from "./squad";
import {
  type ConditionRead,
  type Knowledge,
  knowledgeOf,
  observationOf,
  observedRating,
  KNOWLEDGE_KO,
  observationMargin,
  growthOutlook,
} from "../../players/observation";
import { type CareerSeasonView, type CareerTotalsView, careerTotalsView } from "./career";
import {
  type GameState,
  playerById,
  activeContract,
  activeSuspension,
  openInjury,
  seasonStatOf,
  teamNameIn,
  groupOf,
  teamShortNameIn,
  isOurPlayer,
  assignmentFor,
} from "../../core/state";
import { INJURY_SEVERITY_KO, injuryHistoryOf } from "../../players/injury";
import { competitionShortName } from "../../core/catalog/cup-catalog";
import { careerSeasonRowsOf, foldCareer } from "../../players/career";
import { formLabel, formAngle, formTone } from "../../players/form";
import { conditionShown } from "../../players/observation-view";
import { squadStatusOf } from "../../players/contract-status";
import { isHomegrownFor } from "../../team/registration";
import { matchFatigueOf } from "@gaffer/sim";

// ── 선수 카드 — 이름을 눌러 여는 한 장 (player.md §9.5) ──────

/**
 * 관측된 축 하나 — **값과 그 값이 얼마나 틀릴 수 있는가** (player.md §9).
 *
 * 폭을 함께 싣는 까닭은 명단의 `±N`과 같다: 흐리다는 사실만으로는 **얼마나**
 * 흐린지를 말하지 못해 직접 본 선수와 소문으로만 아는 선수가 같아 보인다.
 * 폭은 축마다 다르다 — 몸과 발(관측형)은 좁고 판단(분석형)은 넓다.
 */
interface PlayerCardAxisView {
  key: AttributeAxis;
  /** **관측값** — 남의 선수에게는 참값이 아니다 */
  value: number;
  margin: number;
}

/**
 * **우리 계약에만 서는 칸** — 상태와 우리 원장 (player.md §9.5).
 *
 * 안개가 걷힌 값이 아니라 우리 훈련장과 우리 장부만 아는 사실이라, 남의 선수
 * 카드에는 이 묶음이 통째로 없다(`null`). 「모름」으로 세우면 없는 자리를 있는
 * 것처럼 그린다.
 */
interface PlayerCardOursView {
  squadNumber: number | null;
  form: number;
  formLabel: string;
  formAngle: number;
  formTone: "up" | "flat" | "down";
  recentRatings: RecentRatingView[];
  /**
   * 체력 — 경기 중 출전 명단에 든 선수는 **판세 탭과 같은 읽은 값**이다
   * (`conditionShown` · player.md §9.2). 카드만 참값을 쓰면 감독이 두 자리를
   * 견주는 것만으로 안개가 걷힌다.
   */
  condition: ConditionRead;
  fatigue: number;
  /**
   * 계약에 적힌 지위 — **계약 정보의 한 칸**이다 (people.md §5-2). 카드는 주급·만료
   * 옆에 세우고 명단에는 세우지 않는다: 명단은 지금 뛰는 자리와 전력을 읽는 표다.
   */
  squadStatus: SquadStatus;
  /** 바이아웃 조항 — 없으면 null (transfer.md §12-3) */
  /**
   * 계약에 적힌 조건 — 코어가 낸 줄 그대로다(`contractTermLines`). 화면은 엔진을 값으로
   * 읽지 못하므로 문장이 여기 실려 간다. 없으면 빈 배열이다.
   */
  isCaptain: boolean;
  isViceCaptain: boolean;
  homegrown: boolean;
  /**
   * 지금 전술판에서 맡은 것 — 배치가 없으면 null.
   *
   * **카드는 고르는 자리가 아니다** — 역할을 바꾸는 손잡이는 전술판 하나뿐이라
   * (읽는 값과 조작 대상은 생김새가 다르다 — overview.md §5) 여기 실리는 것은
   * 지금 무엇을 맡고 있는가뿐이다. **자리가 있어야 역할이 있다**(player.md §3.1) —
   * 좌표가 없는 벤치 배치는 역할 칸이 비어 있다.
   */
  assignment: {
    tier: "선발" | "벤치";
    position: string;
    /** 그 자리의 세부 역할 — 자리가 없는 벤치 배치는 null */
    role: { id: string; ko: string } | null;
    familiarity: number;
  } | null;
  away: SquadViewRow["away"];
  /** 마일스톤 — 최근 것 몇 건 (`SQUAD_MILESTONES_SHOWN`). 장부는 우리 선수만 담는다 */
  milestones: MilestoneView[];
}

/**
 * **선수 한 장** — 이야기와 장부에 선 이름을 누르면 열리는 카드 (player.md §9.5).
 *
 * 매 턴 오는 짐에 싣지 않고 **열 때 하나씩** 온다
 * (`GET /api/games/[id]/player/[playerId]`) — 끝난 경기의 리포트와 같은 길이다
 * (match.md §8). 명단에 설 수 없는 남의 구단 선수가 화면에 서는 첫 자리라 **안개를
 * 통과한 값만 싣는다**: 참값을 보내고 화면이 흐리는 것이 아니라 코어가 흐린 값을
 * 낸다(player.md §9 · §10). 흐리는 것은 능력치뿐이고 기록·계약·국적·부상
 * 이력은 신문에 실리는 사실이라 두 얼굴이 같다.
 */
export interface PlayerCardView {
  id: string;
  name: string;
  age: number;
  /** 소속 구단 — 풀네임. 화면은 카탈로그를 못 읽는다 (`CareerSeasonView.team`과 같은 이유) */
  team: string;
  teamId: string;
  /** 국적은 안개 밖이다 (player.md §10) — 남의 선수도 참값 그대로 */
  nationality: string | null;
  secondNationality: string | null;
  caps: number;
  internationalGoals: number;
  position: string;
  positionGroup: string;
  /** 소화 가능한 자리 — 적응도와 **관측 축에서 낸** 그 자리 전력 (`observedFit`) */
  positions: SquadPositionView[];
  foot: Foot;
  height: number | null;
  weight: number | null;

  /** 이 선수를 얼마나 아는가 — 아래 숫자 전부에 걸리는 단서다 (player.md §9) */
  knowledge: Knowledge;
  knowledgeLabel: string;
  /**
   * 종합값의 오차 폭 (±) — 0이면 정확히 안다.
   *
   * ⚠️ **`Observation`을 통째로 싣지 않는다.** 그 안의 `overallOffset`은 참값에
   * 얹은 오프셋이라, 관측값과 함께 나가면 빼기 한 번에 참 종합이 나온다 — 화면에
   * 그리지 않아도 응답에 실리면 새어 나간 것이다 (player.md §10). 명단 행이 그것을
   * 싣는 것은 전술판이 저장 전 배치의 전력을 **같은 규칙으로 다시 내야** 하기
   * 때문이고(`observedFit`), 카드에는 다시 낼 자리가 없다.
   */
  overallMargin: number;
  /** **관측** 종합 — 참값이 아니다 (`observedOverall`) */
  overall: number;
  /** 16축 — 축마다의 관측값과 오차폭 */
  attributes: PlayerCardAxisView[];
  /** 성장 가능성 — 판단 보류면 null (player.md §9.1) */
  growth: GrowthOutlook | null;

  /** 주급·계약 만료일은 흐리지 않는다 — 공개 기록 계열이다 (player.md §10) */
  weeklyWage: number | null;
  contractUntil: string | null;

  /** 지금 부상 (없으면 null) — 공개 기록이라 남의 선수도 그대로 선다 */
  injury: { bodyPart: string; severity: string; expectedReturn: string } | null;
  /** 출장 정지 잔여 경기 (0이면 정지 아님) */
  suspended: number;
  /** 부상 이력 — 2시즌 창의 건수·결장 일수. **등급이 아니라 사실이다** (player.md §5.3) */
  injuryHistory: InjuryHistory;

  /** 이번 시즌 이 팀의 한 행 — 기록은 안개 밖이다 (player.md §10) */
  season: {
    apps: number;
    goals: number;
    assists: number;
    /** 평균 평점 — 출전이 없으면 null (0.00과 "기록 없음"은 다르다) */
    rating: number | null;
    minutes: number;
    shots: number;
    xg: number;
    saves: number;
    cleanSheets: number;
    yellows: number;
    reds: number;
  };
  /** 이번 시즌 **대회별** — 대회가 하나뿐이면 합계가 같은 수를 말하므로 빈 배열 */
  seasonByCompetition: SquadViewRow["seasonByCompetition"];
  /** 시즌별과 통산 — 스쿼드 상세와 **같은 함수**가 접는다 (player.md §10) */
  career: { seasons: CareerSeasonView[]; totals: CareerTotalsView };

  /** 우리 계약일 때만 — 남의 선수는 null (`isOurPlayer`: 소속이 아니라 계약이 가른다) */
  ours: PlayerCardOursView | null;
}

export function buildPlayerCard(state: GameState, playerId: string): PlayerCardView | null {
  const p = playerById(state, playerId);
  if (!p) return null;
  const knowledge = knowledgeOf(state, p.id);
  const observation = observationOf(state, p.id);
  const observed = Object.fromEntries(
    ATTRIBUTE_AXES.map((a) => [a, observedRating(state, p.id, a, p.attributes[a])]),
  ) as AxisValues;
  const contract = activeContract(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const injury = openInjury(state, p.id);
  const stat = seasonStatOf(state, p.id);
  /** 커리어는 그 선수의 **전 행**을 접는다 — 스쿼드 상세와 같은 자다(`careerViewOf`) */
  const statRows = state.seasonStats.filter((s) => s.gamePlayerId === p.id);
  return {
    id: p.id,
    name: p.name,
    age: ageOf(p.birthdate, state.date),
    team: teamNameIn(state, p.teamId),
    teamId: p.teamId,
    nationality: p.nationality ?? null,
    secondNationality: p.secondNationality ?? null,
    caps: capsOf(p.state),
    internationalGoals: internationalGoalsOf(p.state),
    position: naturalPositionOf(p).position,
    positionGroup: groupOf(p),
    positions: p.positions.map((x) => ({
      ...x,
      overall: observedFit(observed, observation, x.position),
    })),
    foot: p.foot ?? { left: 3, right: 3 },
    height: p.height ?? null,
    weight: p.weight ?? null,
    knowledge,
    knowledgeLabel: KNOWLEDGE_KO[knowledge],
    overallMargin: observation.margin,
    overall: observedOverall(playerOverall(p), observation),
    attributes: ATTRIBUTE_AXES.map((key) => ({
      key,
      value: observed[key],
      margin: observationMargin(state, p.id, key),
    })),
    growth: growthOutlook(state, p),
    weeklyWage: contract?.weeklyWage ?? null,
    contractUntil: contract?.until ?? null,
    injury: injury
      ? {
          bodyPart: injury.bodyPart,
          severity: INJURY_SEVERITY_KO[injury.severity],
          expectedReturn: injury.expectedReturn,
        }
      : null,
    suspended: suspension ? suspension.lengthMatches - suspension.served : 0,
    injuryHistory: injuryHistoryOf(state, p.id),
    season: {
      apps: stat?.apps ?? 0,
      goals: stat?.goals ?? 0,
      assists: stat?.assists ?? 0,
      rating: seasonRating(stat),
      minutes: stat?.minutes ?? 0,
      shots: stat?.shots ?? 0,
      xg: stat?.xg ?? 0,
      saves: stat?.saves ?? 0,
      cleanSheets: stat?.cleanSheets ?? 0,
      yellows: stat?.yellows ?? 0,
      reds: stat?.reds ?? 0,
    },
    seasonByCompetition: competitionRowsOf(
      statRows.filter((s) => s.season === state.season && s.teamId === p.teamId),
    ).map((row) => ({
      competitionId: row.competitionId,
      name: competitionShortName(row.competitionId),
      apps: row.apps,
      goals: row.goals,
      assists: row.assists ?? 0,
    })),
    career: {
      seasons: careerSeasonRowsOf(statRows)
        .map((row) => ({ row, totals: careerTotalsView(row) }))
        .filter(({ totals }) => totals.apps > 0 || totals.reserveApps > 0)
        .map(({ row, totals }) => ({
          season: row.season,
          teamId: row.teamId,
          team: teamShortNameIn(state, row.teamId),
          ...totals,
        })),
      totals: careerTotalsView(foldCareer(statRows)),
    },
    ours: isOurPlayer(state, p) ? oursCardOf(state, p) : null,
  };
}

/**
 * 카드의 우리 칸 — **명단 행이 내는 것과 같은 값**이다.
 *
 * 다른 것은 전술뿐이다: 명단은 역할을 고를 수 있는 목록을 싣지만 카드는 지금 맡은
 * 것 하나를 사실로 싣는다 (카드에는 전술판이 없다).
 */
function oursCardOf(state: GameState, p: GamePlayer): PlayerCardOursView {
  const assignment = assignmentFor(state, p.id);
  const slotted = assignment?.role === "starting";
  /** 자리가 있어야 역할이 있다 — 벤치 배치의 `position`은 주 포지션이 채운 값이다 */
  const role = slotted
    ? (rolesFor(assignment.position).find(
        (r) => r.id === (assignment.roleId ?? defaultRoleOf(assignment.position)),
      ) ?? null)
    : null;
  return {
    squadNumber: p.squadNumber ?? null,
    form: Math.round(p.state.form * 100) / 100,
    formLabel: formLabel(p.state.form),
    formAngle: formAngle(p.state.form),
    formTone: formTone(p.state.form),
    recentRatings: recentRatingsOf(state, p.id),
    condition: conditionShown(state, p.id, p.state.condition, liveWearOf(state, p.id)),
    fatigue: Math.round(fatigueOf(p.state)),
    squadStatus: squadStatusOf(state, p),
    isCaptain: p.isCaptain,
    isViceCaptain: p.isViceCaptain,
    homegrown: isHomegrownFor(p, state.userTeamId),
    assignment: assignment
      ? {
          tier: assignment.role === "starting" ? "선발" : "벤치",
          position: assignment.position,
          role: role ? { id: role.id, ko: role.ko } : null,
          familiarity: assignment.familiarity,
        }
      : null,
    away: awayViewOf(state, p),
    milestones: state.milestones
      .filter((m) => m.gamePlayerId === p.id)
      .slice(-SQUAD_MILESTONES_SHOWN)
      .map((m) => ({ code: m.code, value: m.value, date: m.date, teamId: m.teamId })),
  };
}

/**
 * 지금 뛰고 있는 경기가 이 다리에서 가져간 만큼 — 출전 명단 밖이면 null.
 *
 * 명단 화면이 `liveSlots`로 세우는 그 값이다(`conditionShown`이 이걸 받아 판세 탭과
 * 같은 읽은 값을 낸다). 카드는 한 사람만 물으므로 명단을 세우는 대신 진행 중인 경기를 본다.
 */
function liveWearOf(state: GameState, playerId: string): { drain: number; matchId: string } | null {
  const pending = state.pendingMatch;
  if (state.phase !== "match" || !pending) return null;
  if (!(playerId in pending.live.setup.players)) return null;
  return { drain: matchFatigueOf(pending.live)[playerId] ?? 0, matchId: pending.matchId };
}
