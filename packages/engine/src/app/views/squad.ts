import { type RatingTone, ratingTone } from "../../match/flow/ratings";
import {
  type MilestoneCode,
  type AxisValues,
  type Foot,
  type FatigueBand,
  type InjuryHistory,
  type BoardPoint,
  type SquadStatus,
  type PromiseKind,
  type AssignmentRole,
  type GamePlayer,
  type SetPieceTakers,
  type TacticAssignment,
  type SetPieceRole,
  SET_PIECE_ROLES,
  associationName,
  type SquadRegistration,
  type SetPieceRoutineKey,
  type SetPieceRoutineLevel,
  type MatchSide,
  rolesFor,
  type SeasonStat,
  separateBoardPoints,
  anchorOf,
  competitionRowsOf,
  capsOf,
  internationalGoalsOf,
  fatigueLabel,
  fatigueOf,
  fatigueBand,
  defaultRoleOf,
  seasonRating,
  SET_PIECE_ROUTINE_KEYS,
  setPieceRoutineLevel,
  type GrowthOutlook,
} from "@story-fm/domain";
import {
  type Observation,
  type ConditionRead,
  observedPlayerFacts,
} from "../../common/players/observation";
import { observedFit } from "@story-fm/domain";
import { type MoodRead } from "../../story/players/mood";
import { moodOf } from "../workflows/story/players/mood";
import {
  type CareerSeasonView,
  type CareerTotalsView,
  type YouthIntakeView,
  type StaffMemberView,
  careerTotalsView,
  youthIntakeView,
  staffViews,
} from "./career";
import {
  type GameState,
  ourPlayers,
  tacticsOf,
  FAMILIARITY_BASELINE,
  squadFamiliarity,
  teamShortNameIn,
  openInjury,
  activeSuspensionFor,
  activeContract,
  seasonStatOf,
  groupOf,
  squadLevelOf,
  proficiencyAt,
  adaptationOf,
  isAvailableFor,
} from "../../common/core/state";
import { type TakerSlot, setPieceTakersOf, matchFatigueOf } from "@story-fm/sim";
import { openCallUp } from "../../match/competition/international";
import { internationalBreaksOf } from "../../common/players/international";
import { type TacticsView } from "../../match/views/live";
import { lineupSlotsOf } from "../../match/flow/match-flow";
import { leaderGroupOf } from "../../common/players/hierarchy";
import { careerSeasonRowsOf, foldCareer } from "../../story/players/career";
import { nextMatchFor } from "../../common/core/calendar";
import { competitionShortName } from "../../common/data/cup-catalog";
import {
  isHomegrownFor,
  occupiesSquadList,
  squadRegistrationOf,
} from "../../common/players/registration";
import { formLabel, formAngle, formTone } from "../../common/players/form";
import { conditionShown } from "../../common/views/observation";
import { injuryHistoryOf, INJURY_SEVERITY_KO } from "../../common/players/injury";
import { squadStatusOf } from "../../common/players/contract-status";
import { openPromises } from "../../common/players/promises";

/**
 * 죽은 공 키커 한 자리 — **감독의 지정과 지금 실제로 설 사람이 나란히 선다**
 * (→ docs/match/match.md §1.4 · §2 키커 지정).
 *
 * 둘을 함께 싣는 이유는 둘이 **갈릴 수 있기 때문**이다. 지정은 전술에 남고 한 경기의
 * 명단이 그것을 지우지 않으므로, 지정한 선수를 2군으로 내리거나 선발에서 빼면 이름은
 * 남은 채 그 경기에는 기본값이 선다. 한 칸만 실으면 감독은 그 갈림을 볼 자리가 없다.
 *
 * 이름이 아니라 id다 — 명단 행이 이미 이름을 들고 있어, 뷰가 한 벌 더 적으면 같은
 * 선수의 표기가 두 곳에서 갈린다.
 */
export interface SetPieceTakerView {
  /**
   * 감독이 지정한 선수 — 없으면 `null`.
   *
   * **우리 명단에 없는 id는 싣지 않는다.** 지정이 걷히는 문(`releaseFromTactics`)이
   * 생기기 전의 세이브에는 이미 떠난 선수의 id가 남아 있을 수 있는데, 그것을 그대로
   * 내면 화면이 이름을 찾지 못해 빈칸이 선다.
   */
  designated: string | null;
  /**
   * 지금 선발로 치면 **실제로 차는 사람** — 지정이 없거나 그가 선발 밖이면 코어의
   * 기본값(코너·프리킥은 킥력 최고, 페널티는 `penaltySkill` 최고)이다. 선발이 비면
   * `null`.
   *
   * 경기 중에는 **지금 그라운드에 선 자리에서 같은 규칙으로 고른 값**이다 — 교체로
   * 나간 키커 대신 누가 서 있는지를 선발 명단에서 고르면 화면과 90분이 갈린다.
   */
  taker: string | null;
}

export interface SquadPositionView {
  position: string;
  proficiency: number;
  isNatural: boolean;
  /**
   * **그 자리에 세웠을 때의 전력** — 적응도와는 다른 축이다. 적응도는 "자리를
   * 아는가", 이 값은 "그 자리가 요구하는 능력을 갖췄는가"다 (`roleFit`).
   * 둘은 갈릴 수 있다 — 라이트백을 오래 본 선수라 적응도는 높은데 발이 느려
   * 그 자리 전력은 낮을 수 있다.
   */
  overall: number;
}

/** 최근 경기 평점 한 점 — 색의 경계는 `ratings.ts`가 갖는다 (화면이 다시 자르지 않는다) */
export interface RecentRatingView {
  value: number;
  tone: RatingTone;
}

/**
 * 상세에 세울 마일스톤 수 — 표 옆의 **곁줄**이라 한 줄을 크게 넘기면 그 자체가
 * 또 하나의 목록이 된다. 문턱(50·100경기)은 드물지만 해트트릭은 시즌마다 쌓인다.
 */
export const SQUAD_MILESTONES_SHOWN = 6;

/**
 * 그 선수가 세운 기록 한 건 — **코드와 수치뿐이다.** 문장은 화면이
 * `milestoneTitle`로 만든다 (match.md §6 · overview.md §1 철칙 4).
 *
 * `season`은 싣지 않는다 — `date`가 이미 그것을 말하고, 화면이 세우는 것은
 * 날짜 옆의 라벨 한 줄이다.
 */
export interface MilestoneView {
  code: MilestoneCode;
  value: number;
  date: string;
  /** 어느 셔츠로 세웠나 — 문턱은 클럽 안에서만 센다 */
  teamId: string;
}

export type SquadViewRow = SquadViewRowMeta & AxisValues;

export interface SquadViewRowMeta {
  id: string;
  name: string;
  /** 현재 소속팀 등번호. 아직 배정되지 않았으면 null */
  squadNumber: number | null;
  age: number;
  /** 주 포지션 */
  position: string;
  positionGroup: string;
  /** 가능 포지션 전체 + 적응도 */
  positions: SquadPositionView[];
  /** 표시용 종합 — **관측된 축**에서 파생된 값 (`observedOverall`) */
  overall: number;
  /**
   * **감독이 이 선수를 얼마나 정확히 아는가** (observation.ts).
   *
   * 화면이 자리를 옮겨 보며 같은 규칙으로 전력을 다시 낼 수 있도록 안개 자체를
   * 실어 보낸다 — 참값은 보내지 않는다. `margin`은 그 값이 얼마나 흐린지이고,
   * 화면은 이것으로 정확도를 함께 보여준다.
   */
  observation: Observation;
  /**
   * **지금 맡은 자리 기준 전력** — 배치가 없거나 주 포지션과 요구 역량이 같으면
   * null이다.
   *
   * `overall`은 주 포지션 가중치로만 계산되므로, 센터백을 윙에 세워도 그 숫자는
   * 움직이지 않는다. 그런데 경기에서 쓰이는 값은 **배치된 자리**의 `roleFit`이라
   * (`slotStrength`) 화면과 시뮬이 갈렸다 — 감독이 그 간극을 못 보면 자리를
   * 옮긴 대가가 결과에만 나타난다.
   *
   * 같은 `WeightSlot`이면(LCB↔CB↔RCB) `roleFit`이 정확히 같은 값이라 null로 둔다 —
   * 같은 숫자를 두 번 보여주는 건 정보가 아니라 잡음이다. 좌우 차이는 적응도가 말한다.
   */
  slotOverall: number | null;
  /** 이 팀 기준 홈그로운인가 — 등록 명단의 8명 조건을 채우는 선수 */
  homegrown: boolean;
  /**
   * 국적 — 협회 코드 (`domain/nationality.ts`). 홈그로운과 다른 축이다: 홈그로운은
   * 어디서 자랐는가이고 이것은 누구인가라, 같은 줄에 나란히 선다.
   */
  nationality: string | null;
  /** 둘째 국적 — 없으면 null */
  secondNationality: string | null;
  /**
   * **통산 A매치 출전·골** (→ docs/match/competition.md §5-1) — 국적 바로 옆이다:
   * 같은 사실의 앞뒤라(어느 나라 사람인가 · 그 나라로 몇 번 뛰었나) 떨어져 서면
   * 화면이 둘을 다른 축으로 다룬다. 없으면 0이고, 0을 어떻게 보일지는 화면이 정한다.
   */
  caps: number;
  internationalGoals: number;
  /** 두 발 숙련도 (각 1~5) — 좌우 분화 자리의 적응도를 가른다 */
  foot: Foot;
  /** 키(cm) · 체중(kg) — 묘사용 (전력 계산에는 안 들어간다) */
  height: number | null;
  weight: number | null;
  /** 등록 명단을 차지하는가 (만 21세 초과). U21은 명단 밖이라 언제든 뛴다 */
  occupiesList: boolean;
  /** 성장 가능성 — 코어가 매긴 단계. 판단 보류면 null (player.md §9.1) */
  growth: GrowthOutlook | null;
  squadLevel: "first" | "reserve";
  /**
   * **지금 클럽을 떠나 있는가** — A매치 소집이거나 여름 대회에서 아직 안 돌아왔다
   * (→ docs/match/competition.md §5-1 · season.md §8 불변식). 아니면 null.
   *
   * 부상·정지와 **같은** 갈래라 `available`이 셋을 함께 닫는다 —
   * 화면이 이 칸을 안 보면 소집된 주전이 선발 가능한 얼굴로 명단에 선다.
   *
   * ⚠️ **문장이 아니라 사실이다.** 「잉글랜드 소집 중 (2경기 1골)」을 여기서 이으면
   * 화면이 그 문자열을 다시 갈라야 한다 (competition.md §7 불변식). 나라 **표기**만
   * 뷰가 붙인다 — 화면은 카탈로그를 못 읽는다.
   */
  away: {
    /** A매치 소집인가, 여름 메이저 대회의 늦은 합류인가 */
    reason: "call-up" | "tournament";
    /** 그를 데려간 협회 — FIFA 3자 코드. 국적을 모르는 선수는 null */
    country: string | null;
    /** 그 협회의 한글 표기 — 코드가 없으면 null */
    countryName: string | null;
    /** 클럽으로 돌아오는 날 */
    returnsOn: string;
    /**
     * 이 창의 A매치 출전·골 — **여름 대회는 null이다.** 대회는 굴리지 않으므로
     * (competition.md §5-1) 0을 적으면 「0경기 뛰었다」는 없는 사실이 된다.
     */
    apps: number | null;
    goals: number | null;
  } | null;
  form: number;
  /** 폼의 말 — "절정"·"상승세"·"평소"·"침체"·"바닥" (form.ts와 같은 경계) */
  formLabel: string;
  /**
   * 폼 화살표의 각도(도, 시계 방향 · 0이 12시). **절정(+1)에서만 12시를 본다.**
   * 눈금으로 끊지 않고 연속으로 돌린다 — 경계는 UI가 아니라 form.ts가 정한다.
   */
  formAngle: number;
  /** 화살표 색 계열 */
  formTone: "up" | "flat" | "down";
  /**
   * 최근 경기 평점 — **오래된 것부터** 최대 5개. 폼이 어디서 왔는지 보여주는
   * 시간 축이다 (숫자 하나로는 "오르는 중인지 식는 중인지"를 알 수 없다).
   * 유저 팀 경기에만 평점이 남으므로 그 범위다.
   */
  recentRatings: RecentRatingView[];
  /**
   * **체력** — 지금 이 선수의 상태 0~100 (몸과 마음이 한 축이다).
   * 왜 이 값인지는 `mood` 한 문장이 설명한다.
   *
   * 경기 밖에서는 아침에 잰 값 그대로라 폭이 0이고, **경기 중 출전 명단의 선수는
   * 판세 탭과 같은 읽은 값**이다(`readCondition` · player.md §9.2). 한쪽만 참값을
   * 쓰면 감독이 두 탭을 견주는 것만으로 안개가 걷힌다.
   */
  condition: ConditionRead;
  /**
   * **누적 피로의 말** — "가뿐"·"쌓임"·"지침"·"과부하" (player.md §5.5).
   *
   * 체력 막대와 다른 축이다: 저건 오늘 아침의 예산이고 이건 시즌이 쌓아 둔 잔고라,
   * 경기 다음 날 바닥인 선수와 12월까지 쉬지 못한 선수가 여기서 갈린다. **숫자는
   * 싣지 않는다** — 감독이 관측하는 것은 출전 기록과 일정이다.
   */
  fatigueLabel: string;
  /** 등급 자체 — 화면이 색과 정렬을 이 경계로 맞춘다 */
  fatigueBand: FatigueBand;
  /**
   * **부상 이력** (player.md §5.3) — 2시즌 창 안의 건수·결장 일수·최근 부상.
   *
   * ⚠️ **등급이 아니라 사실이다.** 얼마나 위태로운지는 이력과 오늘의 몸을 함께 읽어야
   * 나오는 판단이고, 그 판단은 이야기를 쥔 쪽이 문장으로 한다 (overview.md §1 철칙 4).
   * 성향 배수도 싣지 않는다 — 감독이 읽을 눈금이 없는 수다 (§10).
   */
  injuryHistory: InjuryHistory;
  /**
   * 지금 심경 — **코어가 고른 사실 카드**와, 결산(LLM)이 다시 쓴 한 줄(`moodOf`).
   * 문장은 화면이 쓴다 (`apps/web/domains/common/lib/mood.ts` · overview.md §1 철칙 4).
   */
  mood: MoodRead;
  /** 배치 역할 — 없으면 예비(스쿼드) */
  role: "선발" | "벤치" | "스쿼드";
  /** 이 전술에서 맡는 포지션 (배치가 있을 때) */
  assignedPosition: string | null;
  /**
   * 그 자리에서 맡는 **세부 역할** — 감독이 고른 것, 없으면 그 자리의 기본 역할.
   * `roleOptions`가 고를 수 있는 목록이고, 자리를 옮기면 목록이 통째로 바뀐다.
   *
   * **자리가 있어야 역할이 있다** (player.md §3.1) — 벤치·예비는 `null`에 빈
   * 목록이다. 주 포지션은 자리가 아니라서, 그 자리 기준의 역할을 켜 두면 화면이
   * 코어가 받지 않는 값을 고르게 한다.
   */
  roleId: string | null;
  roleOptions: Array<{ id: string; ko: string; abbr: string; desc: string }>;
  /**
   * **그 선수가 자리마다 마지막에 맡던 역할** — 자리 코드 → 역할 id
   * (`GameState.roleMemory` → player.md §3.2).
   *
   * 화면이 코어 `inherit`와 **같은 순서로** 되찾기를 재현하는 근거다. 없으면
   * 전술판은 벤치에서 올린 선수에게 기본 역할을 걸어 두었다가 자동 저장 응답이
   * 와서야 기억한 역할로 튄다 — 감독이 누른 적 없는 변경이다.
   *
   * 자리 목록에서 사라진 역할은 싣지 않는다 (`recallRole`과 같은 기준).
   */
  roleMemory: Record<string, string>;
  /**
   * 오늘 역할을 손댄 흔적 (`TacticAssignment.roleMemo`) — **화면이 대가를 저장 전에
   * 낼 수 있게** 함께 보낸다. `role`은 그날 아침의 역할(대가의 기준)이고 `paid`는
   * 오늘 이미 깎인 총량이다. 오늘 손대지 않았으면 null이고 기준은 `roleId`다.
   *
   * **자리 없는 행에도 싣는다** — 코어의 장부는 (선수·오늘)이라 벤치를 다녀와도
   * 흔적이 이어지는데, 선발 행에만 실으면 돌아온 선수의 적응도 미리보기가 서버와
   * 다른 자로 잰 값이 된다. 기준이 되는 자리는 `assignedPosition`이다.
   *
   * **아침의 자리를 벗어나 있으면 null이다** — 역할 목록은 자리마다 다르므로 옛
   * 자리의 역할을 기준으로 재면 화면이 서버와 다른 값을 예고한다 (player.md §7.2).
   */
  roleToday: { role: string; paid: number } | null;
  /** 전술판 좌표 (배치가 있을 때) — 자유 배치 UI의 그리기 기준 */
  assignedPoint: BoardPoint | null;
  /** 전술 적응도 — 이 전술을 얼마나 익혔나 */
  familiarity: number;
  /**
   * **판에 올리면 될 적응도** — 배치가 없는 행에서만 `familiarity`와 다르다.
   *
   * 코어는 배치되는 순간 선반(2군·예비를 다녀온 값)을 먼저 보고, 없을 때만
   * `min(기준선, 팀 적응도)`를 준다 (`newcomerFamiliarity` → player.md §7.3).
   * 화면이 그 규칙을 스스로 계산하면 돌아온 주전을 60으로 예고했다가 저장 뒤
   * 제 값으로 튄다 — 감독이 만들지 않은 상승이다. 규칙은 여기 하나만 둔다.
   */
  familiarityIfSlotted: number;
  /** 지금 맡은 자리의 포지션 적응도 (배치가 없으면 주 포지션 기준) */
  positionFit: number;
  /**
   * **적응도 하나로 합친 값** — 포지션 적응 + 전술 적응 (`adaptationOf`).
   * 명단은 칸이 하나뿐이라 둘 중 하나만 보이면 "왜 낮은지"를 늘 절반만 안다.
   */
  adaptation: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  /**
   * 라커룸 서열 — 리더 그룹 안의 순위(1부터), 그룹 밖이면 `null`
   * (→ docs/story/people.md §5-1). 화면과 조회 도구가 **같은 값**을 읽어야 해서
   * 여기 하나에서만 파생한다.
   */
  leaderRank: number | null;
  seasonGoals: number;
  seasonApps: number;
  seasonAssists: number;
  /**
   * 이번 시즌 **대회별** 1군 기록 — 위 세 칸은 대회 합이라 "리그 12경기 3골"을
   * 말할 자리가 없었다 (→ docs/common/game-state.md §3.4). 많이 뛴 대회부터 서고,
   * 대회가 하나뿐이면 합계가 이미 같은 수를 말했으므로 빈 배열이다.
   *
   * 대회 이름은 여기서 푼다 — 화면은 카탈로그를 읽지 못한다(`CareerSeasonView.team`과
   * 같은 이유).
   */
  seasonByCompetition: Array<{
    competitionId: string;
    /** 약칭 — 한 줄에 서너 대회가 나란히 선다 */
    name: string;
    apps: number;
    goals: number;
    assists: number;
  }>;
  /** 시즌 평균 평점 — 출전이 없으면 null (0.0과 "기록 없음"은 다르다) */
  seasonRating: number | null;
  /**
   * 경기가 남긴 나머지 — 출전 분·슛·xG·선방·클린시트·카드 (match.md §6).
   * 위 넷과 같은 "이번 시즌 이 팀" 한 행이고, 두 시뮬이 같은 눈금으로 얹은 값이라
   * 리그의 어느 선수든 같은 자로 읽힌다. 골키퍼가 아니면 선방·클린시트는 0이다.
   */
  seasonMinutes: number;
  seasonShots: number;
  seasonXg: number;
  seasonSaves: number;
  seasonCleanSheets: number;
  seasonYellows: number;
  seasonReds: number;
  /**
   * **시즌별과 통산** — 위 `season*` 칸들은 "이번 시즌 이 팀" 한 행이라, 3년 함께한
   * 주장이 우리 팀에서 몇 경기를 뛰었는지가 화면 어디에도 없었다.
   *
   * 시즌 행은 **자르지 않는다** — 카드(GM)는 상한을 두지만 상세는 스크롤이 되는
   * 자리고, 표는 전체 이력이 서라고 있는 물건이다. 출전이 0인 행은 애초에 빼므로
   * 개막 전에는 빈 배열이고, 화면은 그때 표를 세우지 않는다.
   *
   * 시즌 오름차순, 같은 시즌 안에서는 팀 id 순 (`careerOf`와 같은 순서).
   */
  career: { seasons: CareerSeasonView[]; totals: CareerTotalsView };
  /**
   * 마일스톤 — **최근 것 몇 건**만 (`SQUAD_MILESTONES_SHOWN`). 장부는 감독 팀
   * 선수만 담으므로 스쿼드 행에는 늘 온전히 있다 (game-state.md §3.4).
   * 오래된 것부터 적는다 — 표의 시즌 행과 같은 방향이다.
   */
  milestones: MilestoneView[];
  hasIssue: boolean;
  /** 주급 (£/주) */
  weeklyWage: number;
  contractUntil: string | null;
  /**
   * **어떤 자리로 왔는가** — 계약에 적힌 지위, 없으면 지금 서열에서 파생
   * (`squadStatusOf` → docs/story/people.md §5-2). 그 지위가 부르는 선발 비율이
   * 출전 불만과 약속 이행을 함께 재므로, 화면과 GM이 **같은 값**을 읽어야 한다.
   */
  squadStatus: SquadStatus;
  /**
   * 아직 기한 전인 **감독의 약속** — 갈래와 기한뿐이다 (people.md §5-2).
   * 무슨 말로 약속했는지는 장면의 것이라 여기 오지 않는다.
   */
  promises: Array<{ kind: PromiseKind; dueOn: string }>;
  /** 현재 부상 (없으면 null) */
  injury: { bodyPart: string; severity: string; expectedReturn: string } | null;
  /** 출장 정지 잔여 경기 (0이면 정지 아님) */
  suspended: number;
  available: boolean;
}

export const ROLE_KO: Record<AssignmentRole, "선발" | "벤치"> = { starting: "선발", bench: "벤치" };

/**
 * 최근 경기 평점 — 폼의 시간 축.
 *
 * 폼 숫자 하나로는 "지금 오르는 중인지 식는 중인지"를 알 수 없다. 평점은 이미
 * 경기별로 남아 있으므로(`MATCH.result.ratings`, 유저 팀 경기만) 날짜순으로
 * 훑어 마지막 다섯 개를 준다 — 화면이 추이를 그릴 수 있다.
 */
export function recentRatingsOf(state: GameState, playerId: string, limit = 5): RecentRatingView[] {
  const rated = state.matches
    .filter((m) => m.result?.ratings?.[playerId] !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rated.slice(-limit).map((m) => {
    const value = m.result!.ratings![playerId]!;
    return { value, tone: ratingTone(value) };
  });
}

/**
 * 죽은 공 키커 셋 — **지정과 지금 실제로 설 사람** (`SetPieceTakerView`).
 *
 * 기본값을 내는 것은 코어의 함수 하나다(`setPieceTakersOf` — 경기가 부르는 바로
 * 그것). 여기서 「킥력 최고」를 다시 재면 명단이 예고한 키커와 90분이 세우는 키커가
 * 갈리고, 그때 감독이 믿는 것은 화면이지 판정이 아니다.
 *
 * 경기 중이면 `live`가 지금 그라운드에서 고른 값이라 그것이 이긴다 (match.md §8).
 */
export function setPieceTakerViews(
  squad: readonly GamePlayer[],
  designated: SetPieceTakers | undefined,
  starters: readonly TacticAssignment[],
  live: Record<SetPieceRole, string | null> | null,
): Record<SetPieceRole, SetPieceTakerView> {
  const byId = new Map(squad.map((p) => [p.id, p] as const));
  /** 우리 명단에 없는 id는 싣지 않는다 — 화면이 이름을 찾지 못해 빈칸이 선다 */
  const ours = (id: string | null | undefined): string | null =>
    id !== null && id !== undefined && byId.has(id) ? id : null;
  const slots: TakerSlot[] = starters.flatMap((a) => {
    const player = byId.get(a.playerId);
    return player ? [{ player, position: a.position }] : [];
  });
  const standing = live ?? setPieceTakersOf(slots, designated);
  return Object.fromEntries(
    SET_PIECE_ROLES.map((role) => [
      role,
      {
        designated: ours(designated?.[role]),
        taker: ours(standing[role]),
      } satisfies SetPieceTakerView,
    ]),
  ) as Record<SetPieceRole, SetPieceTakerView>;
}

/**
 * 클럽을 떠나 있는 한 칸 (`SquadViewRow.away`) — **소집이 먼저다.** 여름 대회의
 * 늦은 합류는 A매치 창과 겹치지 않지만, 겹치는 날이 온다면 지금 그를 데려간 쪽이
 * 소집이다.
 *
 * 복귀일은 창에서 나온다 — 소집 행은 키만 들고 있고 날짜는 시즌에서 파생한다
 * (`internationalBreaksOf` · competition.md §5-1). `available`은 이 칸이 아니라
 * 코어의 `isAvailable`을 읽으므로, 창을 못 찾은 행이 여기서 빠져도 명단 판정은 갈리지 않는다.
 */
export function awayViewOf(state: GameState, player: GamePlayer): SquadViewRow["away"] {
  const callUp = openCallUp(state, player.id);
  if (callUp !== null) {
    const season = Number(callUp.breakKey.split(":")[0]);
    const window = Number.isFinite(season)
      ? internationalBreaksOf(season).find((w) => w.key === callUp.breakKey)
      : undefined;
    return window === undefined
      ? null
      : {
          reason: "call-up",
          country: callUp.country,
          countryName: associationName(callUp.country),
          returnsOn: window.to,
          apps: callUp.apps,
          goals: callUp.goals,
        };
  }
  const summer = player.state.summerReturn;
  if (summer === undefined || state.date >= summer) return null;
  return {
    reason: "tournament",
    country: player.nationality ?? null,
    countryName: player.nationality === undefined ? null : associationName(player.nationality),
    returnsOn: summer,
    apps: null,
    goals: null,
  };
}

export type SquadView = {
  manager: {
    name: string;
    background: string;
    reputation: Record<string, number>;
  };
  players: SquadViewRow[];
  formation: string;
  tactics: TacticsView;
  /** 선발 평균 전술 적응도 — 전술을 바꾸면 떨어진다 */
  familiarity: number;
  editable: boolean;
  firstTeamCount: number;
  reserveCount: number;
  /** 등록 명단 현황 — 1군에서 파생 (저장하지 않는다) */
  registration: SquadRegistration;
  /**
   * **죽은 공 키커** — 자리 셋 각각의 지정과 지금 실제로 설 사람 (`SetPieceTakerView`).
   * 승부의 4분의 1이 세트피스에서 나오는데(match.md §1.4) 감독이 화면에서 만질 수
   * 있는 유일한 자리다.
   */
  setPieces: Record<SetPieceRole, SetPieceTakerView>;
  /**
   * **세트피스 지시** — 가담·수비 두 축 (match.md §1.4). 키커가 「누가 차는가」라면
   * 이쪽은 「몇 명이 서는가」다.
   *
   * 지시하지 않은 축은 **뷰가 중립으로 펴서** 낸다 — 화면이 `undefined`를 보고
   * 「보통」을 스스로 세우면, 코어가 중립으로 읽는 값과 화면이 그리는 낱말이 갈리는
   * 날이 온다 (키커의 기본값을 뷰가 코어 함수로 내는 것과 같은 규약).
   */
  setPieceRoutine: Record<SetPieceRoutineKey, SetPieceRoutineLevel>;
  /**
   * **여름의 유스 후보** — 아직 계약하지 않은 사람들이라 명단 행이 아니라 제 구획을
   * 갖는다 (season.md §6). 소집일이 지나면 null이다.
   *
   * ⚠️ 종합도 성장 가능성도 **관측값**이다 (`youthCandidateFog` — player.md §9). 화면이
   * 참값을 그리면 안개가 뚫린다.
   */
  youthIntake: YouthIntakeView | null;
  /**
   * **구단이 고용한 사람들** — 수석코치·코치·의료진·스카우트 (people.md §2-2).
   * 선수단 화면에 서는 이유는 이들이 감독이 매일 마주하는 사람이어서다: 훈련장에
   * 수석코치 혼자 서 있는 화면은 세계에 셋이 없다는 뜻이었다.
   */
  staff: StaffMemberView[];
};

export function buildSquadView(state: GameState): SquadView {
  const userTeamId = state.userTeamId;
  const squad = ourPlayers(state);
  const tactics = tacticsOf(state, userTeamId);
  const assignments = new Map(tactics.assignments.map((a) => [a.playerId, a] as const));
  /**
   * 배치가 없는 선수를 판에 올리면 코어가 줄 적응도 — **선반이 기준선을 이긴다**
   * (→ player.md §7.3). 화면이 `min(기준선, 팀)`을 스스로 계산하면 2군을 다녀온
   * 선수를 60으로 예고했다가 저장 응답에서 제 값으로 튄다.
   */
  const shelf = new Map((tactics.shelved ?? []).map((s) => [s.playerId, s] as const));
  const ifSlotted = (playerId: string) =>
    shelf.get(playerId)?.familiarity ??
    Math.min(FAMILIARITY_BASELINE, squadFamiliarity(state, userTeamId));
  /**
   * 경기 중이면 **지금 그라운드의 자리**가 명단의 원본이다 (match.md §9) — 교체로 들어온
   * 선수가 어느 자리에 섰는지는 90분이 아는 사실이라 저장된 배치로 되짚지 않는다.
   */
  const liveMatch = state.phase === "match" ? (state.pendingMatch?.live ?? null) : null;
  const liveSide: MatchSide | null =
    liveMatch === null
      ? null
      : liveMatch.setup.sides.home.teamId === userTeamId
        ? "home"
        : liveMatch.setup.sides.away.teamId === userTeamId
          ? "away"
          : null;
  /** 경기 중 실제로 차는 사람 — 지금 자리에서 같은 규칙(`setPieceTakersOf`)으로 선다 */
  const liveTakers =
    liveMatch && liveSide
      ? setPieceTakersOf(
          lineupSlotsOf(state, liveMatch.slots[liveSide]),
          liveMatch.setPieceTakers[liveSide],
        )
      : null;
  const liveSlots = new Map<
    string,
    { role: "starting" | "bench"; position?: string; roleId?: string; point?: BoardPoint }
  >(
    liveMatch && liveSide
      ? [
          ...liveMatch.slots[liveSide].map(
            (s) =>
              [
                s.playerId,
                {
                  role: "starting" as const,
                  position: s.position,
                  ...(s.roleId ? { roleId: s.roleId } : {}),
                  ...(s.point ? { point: s.point } : {}),
                },
              ] as const,
          ),
          ...liveMatch.ledger[liveSide].bench.map(
            (id) => [id, { role: "bench" as const }] as const,
          ),
        ]
      : [],
  );
  /**
   * 경기 중이면 체력은 **지금 값**이다 — 킥오프의 값에서 이 경기가 가져간 만큼을 뺀다.
   * 그 값이 경기 화면과 **같은 문**(`conditionShown`)을 지나므로 같은 선수가 두 탭에서
   * 다른 숫자로 보이지 않는다.
   */
  const worn = liveMatch && liveSide ? matchFatigueOf(liveMatch) : {};
  const liveMatchId = liveMatch && liveSide ? (state.pendingMatch?.matchId ?? null) : null;
  const issues = new Set(state.issues.map((i) => i.gamePlayerId));

  /**
   * 역할 기억 — 선수마다 (자리 → 역할). 화면이 코어 `inherit`의 되찾기를 같은
   * 순서로 재현하는 근거다 (player.md §3.2). 자리 목록에서 사라진 역할은 없는
   * 것으로 본다 — `recallRole`과 같은 기준이라 화면과 코어가 갈리지 않는다.
   */
  const roleMemoryOf = new Map<string, Record<string, string>>();
  for (const memory of state.roleMemory) {
    if (!rolesFor(memory.position).some((r) => r.id === memory.roleId)) continue;
    const byPosition = roleMemoryOf.get(memory.gamePlayerId) ?? {};
    byPosition[memory.position] = memory.roleId;
    roleMemoryOf.set(memory.gamePlayerId, byPosition);
  }

  /**
   * 커리어 · 마일스톤 — **원장을 한 번씩만 훑는다.**
   *
   * 선수마다 `careerOf`를 부르면 마흔 몇 명 × 원장 전체 훑기가 된다 — 비교자
   * 안의 `seasonStatOf`가 그랬던 것과 같은 함정을(위 정렬 주석) 행 만들기에서
   * 다시 밟는 셈이다. 선수 → 행으로 한 번에 갈라 두고 접는 것은 `foldCareer`에
   * 맡긴다: 카드(GM)와 **같은 함수**라 채팅에서 듣는 합과 표의 합이 갈리지 않는다.
   *
   * 스쿼드 선수로 좁혀 담는다 — 원장에는 리그 전체의 행이 있고 여기서 쓰는 것은
   * 우리 명단뿐이다.
   */
  /**
   * 라커룸 서열 — **한 번만 파생한다** (people.md §5-1). 행마다 부르면 마흔 몇 명이
   * 각자 원장을 훑는다.
   */
  const leaderRank = new Map<string, number>();
  leaderGroupOf(state, state.userTeamId).forEach((row, index) => {
    leaderRank.set(row.playerId, index + 1);
  });

  const squadIds = new Set(squad.map((p) => p.id));
  const statsOfPlayer = new Map<string, SeasonStat[]>();
  for (const stat of state.seasonStats) {
    if (!squadIds.has(stat.gamePlayerId)) continue;
    const rows = statsOfPlayer.get(stat.gamePlayerId);
    if (rows) rows.push(stat);
    else statsOfPlayer.set(stat.gamePlayerId, [stat]);
  }
  const milestonesOfPlayer = new Map<string, MilestoneView[]>();
  for (const milestone of state.milestones) {
    if (!squadIds.has(milestone.gamePlayerId)) continue;
    const rows = milestonesOfPlayer.get(milestone.gamePlayerId) ?? [];
    rows.push({
      code: milestone.code,
      value: milestone.value,
      date: milestone.date,
      teamId: milestone.teamId,
    });
    milestonesOfPlayer.set(milestone.gamePlayerId, rows);
  }
  /**
   * 시즌 행 + 통산 — **출전이 0인 시즌은 행을 세우지 않는다.** 원장은 명단에 든
   * 것만으로도 행을 갖고 있어, 걸러 내지 않으면 한 경기도 못 뛴 시즌이 표에
   * 0으로 늘어선다. 통산은 그래도 **전 행**을 접는다 (더해 봐야 같은 값이다).
   */
  const careerViewOf = (playerId: string): SquadViewRow["career"] => {
    const rows = statsOfPlayer.get(playerId) ?? [];
    // 시즌 × 팀 하나가 한 줄이다 — 대회별로 갈린 행을 접는 것은 커리어 표와 **같은
    // 함수**의 몫이다(`careerSeasonRowsOf`), 안 그러면 컵을 뛴 시즌이 두 줄로 선다
    const seasons = careerSeasonRowsOf(rows)
      .map((row) => ({ row, totals: careerTotalsView(row) }))
      .filter(({ totals }) => totals.apps > 0 || totals.reserveApps > 0)
      .map(({ row, totals }) => ({
        season: row.season,
        teamId: row.teamId,
        team: teamShortNameIn(state, row.teamId),
        ...totals,
      }));
    return { seasons, totals: careerTotalsView(foldCareer(rows)) };
  };

  // 선발의 전술판 좌표 — 좌표 없는 배치(채팅 지시)는 코드 기본 좌표로 그리는데,
  // 같은 코드가 둘이면 정확히 같은 점이 되므로 겹침을 풀어 준다. 저장하면 이 좌표가
  // 그대로 기록되어(setLineup) 다음 로드부터는 안정된다.
  const starters = tactics.assignments.filter((a) => a.role === "starting");
  const starterPoints = separateBoardPoints(starters.map((a) => a.point ?? anchorOf(a.position)));
  const pointOf = new Map(starters.map((a, i) => [a.playerId, starterPoints[i]!] as const));

  const roleRank: Record<SquadViewRow["role"], number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
  /**
   * **명단 화면이 답하는 것은 「다음 경기」다** — 정지는 대회의 것이라(match.md §6)
   * 컵 정지 선수가 리그 명단에서 빨갛게 서면 감독이 쓸 수 있는 선수를 잃는다.
   */
  const nextCompetition =
    nextMatchFor(state.matches, userTeamId, state.date)?.competitionId ?? null;
  const players: SquadViewRow[] = squad
    .map((p) => {
      const assignment = assignments.get(p.id);
      const liveSlot = liveSlots.get(p.id);
      const injury = openInjury(state, p.id);
      const suspension = activeSuspensionFor(state, p.id, nextCompetition);
      const contract = activeContract(state, p.id);
      const stat = seasonStatOf(state, p.id);
      /**
       * 대회별 줄 — **위에서 갈라 둔 행에서 고른다.** `seasonStatsByCompetitionOf`를
       * 부르면 마흔 몇 명이 각자 원장을 한 번 더 훑는다(위 커리어 주석과 같은 함정).
       * 무엇이 서고 무엇이 빠지는가는 선수 카드와 **같은 함수**가 갖는다.
       */
      const byCompetition = competitionRowsOf(
        (statsOfPlayer.get(p.id) ?? []).filter(
          (s) => s.season === state.season && s.teamId === p.teamId,
        ),
      ).map((row) => ({
        competitionId: row.competitionId,
        name: competitionShortName(row.competitionId),
        apps: row.apps,
        goals: row.goals,
        assists: row.assists ?? 0,
      }));
      const facts = observedPlayerFacts(state, p);
      /**
       * **안개는 축에만 씌운다.** 종합·자리 전력은 그 관측된 축에서 파생시킨다
       * (`observedFit`) — 값마다 따로 오차를 굴리면 자리끼리 앞뒤가 안 맞고,
       * 무엇보다 **화면이 같은 계산을 재현할 수 없다**(참값이 없으므로). 그래서
       * 자리를 옮겨 보는 전술판은 "서버 값에 차이만 얹는" 보정을 해야 했고,
       * 그 보정이 명단과 갈려 같은 선수의 OVR이 두 숫자로 보였다.
       *
       * 이제 규칙은 하나다 — **관측된 축 + 하나의 오프셋**. 서버와 화면이 같은
       * 함수를 부르므로 어디서 계산해도 같은 값이 나온다.
       */
      const { observation, attributes: observed } = facts;
      // 역할을 함께 넘긴다 — 같은 센터백이라도 노넌센스와 볼 플레잉은 요구가 다르다.
      // 그래야 감독이 역할을 바꿨을 때 화면의 숫자가 그 자리에서 곧바로 답한다.
      const slotFit = (position: string, role?: string) =>
        observedFit(observed, observation, position, role);
      const assignedSlot = liveSlot?.position ?? assignment?.position ?? null;
      /**
       * **자리가 있는가** — 역할이 성립하는 조건이다 (player.md §3.1).
       *
       * 벤치·예비 배치에는 좌표가 없어 `position`이 주 포지션으로 채워지는데, 그걸
       * 자리로 치면 화면은 그 자리의 역할 목록을 켜고 코어는 그 역할을 받지 않는다 —
       * 화면은 CF라 말하고 오류는 ST라 답하던 지점이다.
       *
       * 역할 기억(§3.2)은 여기서 보지 않는다 — 되찾기는 코어가 배치에 적어 넣는
       * 일이고(`setLineup`의 승계), 화면이 따로 기억을 읽으면 배치에 없는 역할을
       * 화면만 말하게 된다. 기억은 다시 선발이 될 때 `roleId`로 서서 온다.
       */
      const slotted = (liveSlot?.role ?? assignment?.role) === "starting";
      const assignedRoleId = slotted ? (liveSlot?.roleId ?? assignment?.roleId) : undefined;
      const shownOverall = facts.overall;
      const slotValue = assignedSlot ? slotFit(assignedSlot, assignedRoleId) : null;
      return {
        id: p.id,
        name: p.name,
        squadNumber: p.squadNumber ?? null,
        age: facts.age,
        position: facts.position,
        positionGroup: groupOf(p),
        positions: p.positions.map((x) => ({ ...x, overall: slotFit(x.position) })),
        overall: shownOverall,
        observation,
        /**
         * 이 자리·이 **역할**에서 내는 전력 — 기본값과 다를 때만 채운다.
         *
         * ⚠️ 자리 묶음만 보지 않는다. 센터백이 센터백 자리에 선 채로 **역할만**
         * 바꿔도(볼 플레잉 디펜더 ↔ 노넌센스) 요구 역량이 달라지므로, 자리든
         * 역할이든 기본과 달라지면 그 값을 낸다.
         */
        slotOverall: slotValue !== null && slotValue !== shownOverall ? slotValue : null,
        // 오피스는 우리 선수의 숫자를 그대로 보여준다 (player.md §10).
        ...observed,
        growth: facts.growth,
        homegrown: isHomegrownFor(p, userTeamId),
        nationality: p.nationality ?? null,
        secondNationality: p.secondNationality ?? null,
        caps: capsOf(p.state),
        internationalGoals: internationalGoalsOf(p.state),
        foot: p.foot ?? { left: 3, right: 3 },
        height: p.height ?? null,
        weight: p.weight ?? null,
        occupiesList: occupiesSquadList(state, p),
        squadLevel: squadLevelOf(p),
        away: awayViewOf(state, p),
        form: Math.round(p.state.form * 100) / 100,
        formLabel: formLabel(p.state.form),
        formAngle: formAngle(p.state.form),
        formTone: formTone(p.state.form),
        recentRatings: recentRatingsOf(state, p.id),
        condition: conditionShown(
          state,
          p.id,
          p.state.condition,
          liveSlot && liveMatchId ? { drain: worn[p.id] ?? 0, matchId: liveMatchId } : null,
        ),
        fatigueLabel: fatigueLabel(fatigueOf(p.state)),
        fatigueBand: fatigueBand(fatigueOf(p.state)),
        injuryHistory: injuryHistoryOf(state, p.id),
        mood: moodOf(state, p),
        role: (liveMatchId
          ? liveSlot
            ? ROLE_KO[liveSlot.role]
            : "스쿼드"
          : assignment
            ? ROLE_KO[assignment.role]
            : "스쿼드") as SquadViewRow["role"],
        assignedPosition: assignedSlot,
        roleId: slotted && assignedSlot ? (assignedRoleId ?? defaultRoleOf(assignedSlot)) : null,
        roleOptions:
          slotted && assignedSlot
            ? rolesFor(assignedSlot).map((r) => ({
                id: r.id,
                ko: r.ko,
                abbr: r.abbr,
                desc: r.desc,
              }))
            : [],
        roleMemory: roleMemoryOf.get(p.id) ?? {},
        /**
         * **자리가 없어도 싣는다.** 코어의 장부는 (선수·오늘)이라 벤치를 다녀와도
         * 흔적이 이어진다. 선발 행에만 실으면 돌아온 선수의 적응도 미리보기가
         * 서버와 다른 자로 잰 값이 된다.
         *
         * 다만 **아침의 자리가 아니면 싣지 않는다** — 코어는 그 자리에서만 아침의
         * 역할과 견주고 나머지 자리에서는 낸 값을 되돌린다(`settleRoleCost`).
         * 옛 자리의 역할을 기준으로 재면 화면이 서버가 매기지 않을 값을 예고한다.
         * 어느 자리의 흔적인지는 `assignedPosition`이 말한다.
         */
        roleToday:
          assignment?.roleMemo?.date === state.date && assignment.roleMemo.position === assignedSlot
            ? { role: assignment.roleMemo.role, paid: assignment.roleMemo.paid }
            : null,
        assignedPoint: liveSlot?.point ?? pointOf.get(p.id) ?? null,
        // 저장은 소수지만 화면은 눈금이다 — 87.4와 87.7을 감독이 구분할 일은 없다
        familiarity: Math.round(assignment?.familiarity ?? FAMILIARITY_BASELINE),
        familiarityIfSlotted: Math.round(assignment?.familiarity ?? ifSlotted(p.id)),
        positionFit: proficiencyAt(p, assignedSlot ?? facts.position),
        adaptation: adaptationOf(
          proficiencyAt(p, assignedSlot ?? facts.position),
          assignment?.familiarity ?? FAMILIARITY_BASELINE,
          assignedSlot ?? facts.position,
        ),
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain === true,
        leaderRank: leaderRank.get(p.id) ?? null,
        seasonGoals: stat?.goals ?? 0,
        seasonApps: stat?.apps ?? 0,
        seasonByCompetition: byCompetition.length < 2 ? [] : byCompetition,
        seasonAssists: stat?.assists ?? 0,
        seasonRating: seasonRating(stat),
        seasonMinutes: stat?.minutes ?? 0,
        seasonShots: stat?.shots ?? 0,
        seasonXg: stat?.xg ?? 0,
        seasonSaves: stat?.saves ?? 0,
        seasonCleanSheets: stat?.cleanSheets ?? 0,
        seasonYellows: stat?.yellows ?? 0,
        seasonReds: stat?.reds ?? 0,
        career: careerViewOf(p.id),
        milestones: (milestonesOfPlayer.get(p.id) ?? []).slice(-SQUAD_MILESTONES_SHOWN),
        hasIssue: issues.has(p.id),
        weeklyWage: contract?.weeklyWage ?? 0,
        contractUntil: contract?.until ?? null,
        squadStatus: squadStatusOf(state, p),
        promises: openPromises(state, p.id).map((pr) => ({ kind: pr.kind, dueOn: pr.dueOn })),
        injury: injury
          ? {
              bodyPart: injury.bodyPart,
              severity: INJURY_SEVERITY_KO[injury.severity],
              expectedReturn: injury.expectedReturn,
            }
          : null,
        suspended: suspension ? suspension.lengthMatches - suspension.served : 0,
        /**
         * **코어의 문을 그대로 읽는다** — 부상·정지에 더해 소집·여름 대회까지
         * 한 자리에서 판정한다 (`isAvailableFor` → season.md §8 불변식). 여기서
         * 조건을 다시 세면 소집된 주전이 화면에서만 선발 가능한 얼굴로 선다.
         */
        available: isAvailableFor(state, p, nextCompetition),
      } satisfies SquadViewRow;
    })
    .sort((a, b) =>
      a.role === b.role ? b.overall - a.overall : roleRank[a.role] - roleRank[b.role],
    );

  return {
    manager: {
      name: state.manager.name,
      background: state.manager.background,
      reputation: { ...state.manager.reputation },
    },
    players,
    formation: tactics.spec.formation,
    tactics: { ...tactics.spec },
    familiarity: Math.round(squadFamiliarity(state, userTeamId)),
    // 경기 중과 커리어가 끝난 뒤에 꺼진다 (career.md §5.1)
    editable: state.phase !== "match" && !state.dismissal,
    firstTeamCount: players.filter((p) => p.squadLevel === "first").length,
    reserveCount: players.filter((p) => p.squadLevel === "reserve").length,
    registration: squadRegistrationOf(state, userTeamId),
    setPieces: setPieceTakerViews(squad, tactics.setPieceTakers, starters, liveTakers),
    setPieceRoutine: Object.fromEntries(
      SET_PIECE_ROUTINE_KEYS.map((key) => [
        key,
        setPieceRoutineLevel(tactics.setPieceRoutine, key),
      ]),
    ) as Record<SetPieceRoutineKey, SetPieceRoutineLevel>,
    youthIntake: youthIntakeView(state),
    staff: staffViews(state),
  };
}
