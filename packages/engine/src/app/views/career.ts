import { personaBookOf } from "../../common/people/character-book";
import {
  type StaffRole,
  type Persona,
  STAFF_ROLES,
  personaRoleLabel,
  ageOf,
  naturalPositionOf,
  type AchievementCode,
} from "@story-fm/domain";
import { type CareerTotals } from "../../story/players/career";
import { type GameState, teamNameIn } from "../../common/core/state";
import { headCoachOf, staffOf } from "../../common/people/persona";
import { ourYouthCandidates, youthIntakeDeadline } from "../season";
import { youthCandidateFog } from "../../common/players/observation";
import { managerTenureOf, managerTrophiesOf } from "../../match/competition/records";
import { openManagerOffers } from "../../negotiation/market/manager-market";
import { tierOfTeamIn } from "../../common/core/club-tier";
import { competitionName } from "../../common/data/cup-catalog";
import { leagueName } from "../../common/data/league-catalog";

/**
 * 커리어 한 묶음 — 시즌 행과 통산 행이 **같은 모양**이다. 표의 마지막 줄이
 * 위의 행들과 같은 열을 쓰므로, 화면이 통산만 따로 그리지 않아도 된다.
 *
 * 저장하지 않는다 — `SEASON_STAT` 전 행을 `foldCareer`로 접은 값이다
 * (→ docs/common/game-state.md §5). 평점은 **합계가 아니라 평균**을 싣는다:
 * 화면이 나눗셈을 다시 하면 코어와 다른 자리에서 반올림한다.
 */
export interface CareerTotalsView {
  apps: number;
  goals: number;
  assists: number;
  /** 평균 평점 — 출전이 없으면 null (0.00과 "기록 없음"은 다르다) */
  rating: number | null;
  /**
   * 2군 리그 — 1군과 **섞지 않는다** (season.md §2). 섞으면 표의 "출전 38"이
   * 1·2군 혼합값이 되고, 마일스톤이 세는 수와도 갈린다.
   */
  reserveApps: number;
  reserveGoals: number;
}

/** 시즌 한 줄 — 시즌 안에 팀을 옮겼으면 **행도 팀별로 갈린다** (player.md §10) */
export interface CareerSeasonView extends CareerTotalsView {
  season: number;
  teamId: string;
  /** 팀 약칭 — 화면은 카탈로그를 못 읽는다 (엔진을 타입으로만 import한다) */
  team: string;
}

/** 스쿼드 행 = 메타 + 16축 (오피스 뷰는 우리 선수라 숫자를 그대로 준다) */
/**
 * **여름의 유스 후보 한 줄** — 아직 계약하지 않은 사람이라 `SquadViewRow`가 아니다
 * (season.md §6). 층도 배치도 등번호도 없고, 대신 첫 프로 계약의 조건이 붙는다.
 */
export interface YouthCandidateView {
  /** 후보의 선수 id — `sign_youth`가 받는 그 값이다 */
  id: string;
  name: string;
  age: number;
  position: string;
  /** **관측** 종합 — 참값이 아니다 (player.md §9) */
  overall: number;
  /** 잠재력 추정 구간 — 후보는 언제나 구간이 선다 (`adapting` 눈금) */
  potential: { low: number; high: number; confidence: string };
  weeklyWage: number;
  years: number;
  /** 답이 없으면 구단이 데려가는 자리인가 */
  autoSign: boolean;
}

/** 이번 여름의 인테이크 — 후보가 없으면 이 구획 자체가 서지 않는다 */
export interface YouthIntakeView {
  /** 감독의 답을 기다리는 마지막 날 = 선수단 소집일 */
  deadline: string;
  candidates: YouthCandidateView[];
}

/**
 * **스태프 한 줄** — 구단이 고용한 사람 (people.md §2-2). 감독이 훈련장·의무실에서
 * 매일 마주하는 사람들이고, 명단 행이 아니라 제 구획에 선다: 부릴 수 있는 인원이
 * 아니다.
 *
 * ⚠️ **코어는 사실만 낸다** — 「부임 2년째」는 화면이 오늘과 `since`로 만든다
 * (overview.md §1 철칙 4). 고용 정보가 없는 사람은 날짜 칸이 null이다.
 */
export interface StaffMemberView {
  /** 이름 = `characterId` — 채팅에서 그를 부르는 그 이름이다 (people.md §1) */
  name: string;
  /** 자리 — 화면의 아이콘이 `speakerRoles`의 `kind`와 **같은 표**를 보고 고른다 */
  role: "head_coach" | StaffRole;
  /** 이름 옆의 직책 — 「피지컬 코치」. 역할 라벨(「코치」)보다 좁다 */
  title: string;
  /** 세이브의 최신 캐릭터북 설명 */
  description: string;
  /** 부임일 — 감독보다 앞설 수 있다 (people.md §2-2) */
  since: string | null;
  /** 계약 만료일 — 시즌 단위로 끝난다 */
  until: string | null;
}

/**
 * 접힌 합계에서 **표가 쓰는 것만** — 평점은 합계가 아니라 평균을 싣는다.
 * `ratingSum`을 보내고 화면이 나누면 코어와 다른 자리에서 반올림한다.
 */
export function careerTotalsView(t: CareerTotals): CareerTotalsView {
  return {
    apps: t.apps,
    goals: t.goals,
    assists: t.assists,
    rating: t.rating,
    reserveApps: t.reserveApps,
    reserveGoals: t.reserveGoals,
  };
}

/**
 * 스태프 구획 — **수석코치가 맨 앞이고 그다음이 코치·의료진·스카우트다.** 사람이
 * 읽는 순서이고, `staffOf`의 저장 순서가 아니다: 세이브에 담긴 차례는 생성 순서라
 * 감독이 그 판을 볼 이유가 없다.
 *
 * 수석코치는 자리가 비지 않는다 (`headCoachOf`는 없으면 던진다).
 * 자른 자리는 그냥 줄이 하나 없다 — 빈 칸을 세우지 않는다.
 */
export function staffViews(state: GameState): StaffMemberView[] {
  const rows: Array<{ persona: Persona; role: StaffMemberView["role"] }> = [
    { persona: headCoachOf(state), role: "head_coach" },
    ...STAFF_ROLES.flatMap((role) => staffOf(state, role).map((persona) => ({ persona, role }))),
  ];
  return rows.map(({ persona, role }) => ({
    name: persona.name,
    role,
    // 고용 정보가 없는 사람은 역할 라벨로 선다 — 화자 칩(`speakerRoles`)과 같은 폴백이다
    title: persona.employment?.title ?? personaRoleLabel(role) ?? role,
    description: personaBookOf(state, persona).description,
    since: persona.employment?.since ?? null,
    until: persona.employment?.contract.until ?? null,
  }));
}

/**
 * 유스 후보 구획 — **안개는 조회·GM 스냅샷과 같은 함수를 지난다**
 * (`youthCandidateFog`). 화면이 참값을 그리면 같은 후보가 두 숫자로 갈린다.
 */
export function youthIntakeView(state: GameState): YouthIntakeView | null {
  const rows = ourYouthCandidates(state);
  if (rows.length === 0) return null;
  return {
    deadline: youthIntakeDeadline(state),
    candidates: rows.map((row) => {
      const { overall, potential } = youthCandidateFog(state.seed, row.player);
      return {
        id: row.player.id,
        name: row.player.name,
        age: ageOf(row.player.birthdate, state.date),
        position: naturalPositionOf(row.player).position,
        overall,
        potential: { low: potential.low, high: potential.high, confidence: potential.confidence },
        weeklyWage: row.weeklyWage,
        years: row.years,
        autoSign: row.autoSign,
      };
    }),
  };
}

export type CareerView = {
  /**
   * **경질 카드** — 서 있으면 감독은 무직이다 (career.md §5.1). 코어는 사실만
   * 넘기고("어느 구단에서 몇 위") 문장은 화면이 쓴다.
   */
  dismissal: {
    on: string;
    season: number;
    /** 경질·만료·사임·이적 — 무직은 상태지 사유가 아니다 (career.md §5.4) */
    kind: "sacked" | "expired" | "resigned" | "moved";
    /**
     * 위약금 — 경질이면 구단이 문 돈, 사임이면 감독이 문 돈, 이적이면 새 구단이
     * 옛 구단에 문 보상금이다 (career.md §5.4 · §5.1)
     */
    severance: number | null;
    teamName: string;
    tier: number;
    /** 경질일의 리그 순위 — 아직 리그전을 치르지 않았으면 null */
    position: number | null;
  } | null;
  /**
   * **경질 이력** — 부임이 카드를 옮겨 남긴 지난 경질들 (career.md §6).
   * 잘린 시즌은 `SEASON_RECORD`가 없으므로 시즌 표가 이 줄로 그 해를 채운다.
   */
  dismissals: Array<{
    on: string;
    season: number;
    /** 경질·만료·사임·이적 (career.md §5.4) */
    kind: "sacked" | "expired" | "resigned" | "moved";
    teamName: string;
    position: number | null;
  }>;
  /**
   * **지금 답할 수 있는 감독직 제안** — 만료가 가까운 것이 앞이다.
   * 수락은 채팅으로 한다(`accept_manager_offer`) — 화면은 무엇이 걸려 있는지만 세운다.
   */
  offers: Array<{
    id: string;
    /**
     * 어떻게 선 제안인가 — `vacancy`만 무직에게 붙는다. 재계약(`renewal`)과 이직
     * 제안(`poach` · 재직 중의 `knock`)은 재직 중에 선다 (career.md §5.1 · §5.4)
     */
    via: "vacancy" | "knock" | "renewal" | "poach";
    teamName: string;
    tier: number;
    expiresOn: string;
    position: number | null;

    /** 제시 조건 (career.md §5.1) */
    salary: number;
    years: number;
    budgetPledge: number;
    /**
     * 새 구단이 지금 구단에 물 **이적 보상금** — 재직 중에 온 제안에만 있다
     * (career.md §5.1)
     */
    compensation: number | null;
  }>;
  /**
   * **공석 명부** — 감독이 먼저 지원할 수 있는 자리 (career.md §5.1). 재직 중에도
   * 쌓인다 — 계약을 남기고 떠나는 길이 열려 있다.
   * 지원은 채팅으로 한다(`apply_manager_job`) — 화면은 어느 문이 열려 있는지만 세운다.
   */
  vacancies: Array<{ teamName: string; tier: number; on: string; position: number | null }>;
  /** 감독 계약 — 무직이면 null. */
  contract: {
    salary: number;
    until: string;
  } | null;
  trophies: Array<{ competition: string; season: number; teamName: string }>;
  /**
   * 업적 — **코드와 근거 수치**다. 세이브가 문장을 갖지 않으므로(career.md §6)
   * 이름과 근거 문장은 화면이 코드로 쓴다(`achievementTitle`). 여기서 하는 일은
   * id를 표시명으로 푸는 것까지다 — 화면은 리그·대회 카탈로그를 읽지 못한다.
   */
  achievements: Array<{
    code: AchievementCode;
    season: number;
    position?: number;
    leagueName?: string;
    competitionName?: string;
    playerName?: string;
    goals?: number;
    matches?: number;
  }>;
  /**
   * 시상 — 업적과 같은 규약이다: **코드와 근거 수치**만 내려가고 상의 이름은
   * 화면이 코드로 만든다(`awardTitle` — career.md §6). 세계 전체에 쌓이는 상
   * 중에서 **감독이 그 시즌 맡고 있던 팀의 것**만 선다 — 남의 리그 득점왕은
   * 감독의 이력이 아니다. 대회는 리그만이 아니다: 컵·대항전의 득점왕과 결승
   * MOM도 같은 자로 걸린다. id를 표시명으로 푸는 것까지가 여기 몫이다.
   */
  awards: Array<{
    code: string;
    season: number;
    playerName: string;
    teamName: string;
    /** 어느 대회의 상인가 — 리그도 컵·대항전도 온다 (season.md §6) */
    competitionName: string;
    apps: number;
    goals: number;
    assists: number;
    /** 출전이 없으면 없다 (`seasonRating`) */
    rating?: number;
    /** `young-player`가 센 나이 — 시즌 종료일 기준 */
    age?: number;
  }>;
  seasons: Array<{
    season: number;
    teamName: string;
    position: number;
    /** 그 시즌의 전적 — `"20승 8무 10패"`는 화면이 잇는다 (career.md §6) */
    record: { wins: number; draws: number; losses: number };
  }>;
};

export function buildCareerView(state: GameState): CareerView {
  const managedThen = managerTenureOf(state);

  return {
    dismissal: state.dismissal
      ? {
          on: state.dismissal.on,
          season: state.dismissal.season,
          kind: state.dismissal.kind,
          severance: state.dismissal.severance ?? null,
          teamName: teamNameIn(state, state.dismissal.teamId),
          tier: state.dismissal.tier,
          position: state.dismissal.position ?? null,
        }
      : null,
    dismissals: state.dismissals.map((d) => ({
      on: d.on,
      season: d.season,
      kind: d.kind,
      teamName: teamNameIn(state, d.teamId),
      position: d.position ?? null,
    })),
    offers: openManagerOffers(state).map((o) => ({
      id: o.id,
      via: o.via,
      teamName: teamNameIn(state, o.teamId),
      tier: o.tier,
      expiresOn: o.expiresOn,
      position: o.position ?? null,

      salary: o.salary,
      years: o.years,
      budgetPledge: o.budgetPledge,
      compensation: o.compensation ?? null,
    })),
    vacancies: state.managerVacancies.map((v) => ({
      teamName: teamNameIn(state, v.teamId),
      tier: tierOfTeamIn(state, v.teamId),
      on: v.on,
      position: v.position ?? null,
    })),
    /**
     * 계약 — **수치와 기간만** 내려간다 (career.md §5.4 · overview.md §1 철칙 4).
     */
    contract: state.manager.contract
      ? {
          salary: state.manager.contract.salary,
          until: state.manager.contract.until,
        }
      : null,
    /**
     * 보관함은 **감독의 것만** — 원장은 전 구단의 우승을 든다 (career.md §6).
     * 그대로 실으면 AI 구단의 우승이 감독의 보관함에 선다.
     */
    trophies: managerTrophiesOf(state).map((t) => ({
      competition: competitionName(t.competitionId),
      season: t.season,
      teamName: teamNameIn(state, t.teamId),
    })),
    achievements: state.achievements.map((a) => ({
      code: a.code,
      season: a.season,
      position: a.position,
      leagueName: a.leagueId ? leagueName(a.leagueId) : undefined,
      competitionName: a.competitionId ? competitionName(a.competitionId) : undefined,
      playerName: a.playerName,
      goals: a.goals,
      matches: a.matches,
    })),
    // 감독이 그 시즌 그 팀에 있었는가 — 트로피 보관함과 **같은 자**로 잰다 (career.md §6)
    awards: state.awards
      .filter((a) => managedThen(a.season, a.teamId))
      .map((a) => ({
        code: a.code,
        season: a.season,
        playerName: a.playerName,
        teamName: teamNameIn(state, a.teamId),
        competitionName: competitionName(a.competitionId),
        apps: a.apps,
        goals: a.goals,
        assists: a.assists,
        rating: a.rating,
        age: a.age,
      })),
    seasons: state.seasonRecords.map((s) => ({
      season: s.season,
      teamName: teamNameIn(state, s.teamId),
      position: s.position,
      record: { wins: s.wins, draws: s.draws, losses: s.losses },
    })),
  };
}
