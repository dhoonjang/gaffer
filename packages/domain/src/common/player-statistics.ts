import { z } from "zod";
import { SQUAD_NUMBER_MAX, type PositionGroup } from "./player";
import { RESERVE_COMPETITION_PREFIX } from "./match-records";
import { DateString } from "./date-string";

// ── 시즌 기록 ─────────────────────────────────────────
export const SeasonStatSchema = z.object({
  gamePlayerId: z.string().min(1),
  season: z.number().int(),
  /** 그 시즌 소속 — 시즌 중 소속이 바뀌면 팀별로 row가 분리된다 */
  teamId: z.string().min(1),
  /**
   * **어느 대회의 기록인가** — 행의 네 번째 열쇠다 (→ docs/common/game-state.md §3.4).
   * 리그·컵·대항전이 저마다 행을 갖고, 2군 리그는 그 대회 id(`reserve:<리그>`)의
   * 행에 `reserve*` 칸으로 쌓인다. 축이 없으면 "리그 12경기 3골"을 말할 자리가 없다.
   * 시즌 합계는 저장하지 않고 행을 접어 낸다(`sumSeasonStats`).
   *
   * ⚠️ **`apps`·`goals` 뒤의 칸은 0이면 적지 않는다** — 얹는 자리(`addToSeasonStat`)가
   * 0인 델타를 건너뛰므로 없는 칸은 0이다. 마감 한 번에 0으로만 채워진 칸이 수천 행에
   * 서지 않게 하는 규약이다.
   */
  competitionId: z.string().min(1),
  apps: z.number().int().min(0),
  goals: z.number().int().min(0),
  /** 도움 — 골 이벤트의 actors[1] */
  assists: z.number().int().min(0).optional(),
  /**
   * 경기 평점의 **합계**. 시즌 평점은 여기서 파생된다(`seasonRating`) —
   * 평균을 저장하면 경기마다 재계산해야 하고 반올림 오차가 누적된다.
   */
  ratingSum: z.number().min(0).optional(),
  /**
   * 2군 리그 기록 — 1군 기록(`apps` 등)과 섞이지 않는다. 섞으면 화면의 "출전 N"이
   * 1·2군 혼합값이 된다 (simulation/season.md §2 2군 리그).
   */
  reserveApps: z.number().int().min(0).optional(),
  reserveGoals: z.number().int().min(0).optional(),
  reserveAssists: z.number().int().min(0).optional(),
  reserveRatingSum: z.number().min(0).optional(),
  /**
   * 출전 시간(분) 합계. 아래 여섯 칸과 함께 **1군 대회 경기만** 센다
   * (→ docs/match/match.md §6) — 얹는 자리는 `addToSeasonStat` 하나다.
   */
  minutes: z.number().int().min(0).optional(),
  shots: z.number().int().min(0).optional(),
  /** 그 선수가 만든 기회의 질 합 — 결정력 반영 전의 값이다 (match.md §1.4) */
  xg: z.number().min(0).optional(),
  /** 선방 — 골키퍼의 칸이다 */
  saves: z.number().int().min(0).optional(),
  /** 무실점 경기 — 골키퍼의 칸이다 (`keptCleanSheet`) */
  cleanSheets: z.number().int().min(0).optional(),
  /** 경고·퇴장 — `BOOKING`이 원본이고 합계는 `recordCard`가 함께 적는다 */
  yellows: z.number().int().min(0).optional(),
  reds: z.number().int().min(0).optional(),
  /**
   * 그 시즌 그 셔츠의 **등번호** — 번호 계보(`numberLineageOf`)가 읽는 유일한 원본이다
   * (player.md §1.1).
   *
   * `GamePlayer.squadNumber`는 **지금** 번호라 지난 시즌 누가 10번이었는지를 모른다.
   * 그것을 아는 표가 없으면 "누구 뒤를 잇는가"가 세계에 설 자리가 없다.
   * `ensureSeasonStat`가 부를 때마다 지금 번호로 덮어쓴다 — 시즌 중에 바뀌면
   * 마지막 번호가 그 시즌의 번호다. 번호가 없는 선수의 행엔 없다.
   */
  squadNumber: z.number().int().min(1).max(SQUAD_NUMBER_MAX).optional(),
  /**
   * 그때의 **이름** — 은퇴하면 선수가 `state.players`에서 빠져 id로는 더 못 찾는다
   * (`SeasonAward.playerName`·`Achievement.playerName`과 같은 이유). 역대 득점왕과
   * 통산 표가 사라진 이름을 되찾는 유일한 자리다.
   */
  playerName: z.string().min(1).optional(),
});

export type SeasonStat = z.infer<typeof SeasonStatSchema>;

/**
 * 대회 행을 접은 **시즌 합계** — 대회 축이 없다. 합계에서 대회를 묻지 말 것.
 * 저장하지 않는 파생값이다 (→ docs/common/game-state.md §5).
 */
export type SeasonStatTotal = Omit<SeasonStat, "competitionId">;

/**
 * 클린시트로 세는 최소 출전 분 — 90분의 3분의 2.
 *
 * 0으로 두면 85′에 들어와 0-0으로 끝난 교체 골키퍼가 남의 클린시트를 가져가고,
 * 90분으로 두면 부상 교체 한 번이 그때까지 지켜 낸 기록을 지운다.
 */
export const CLEAN_SHEET_MINUTES = 60;

/**
 * 이 경기가 그 선수의 클린시트인가 — **골키퍼의 기록이다.**
 *
 * 수비수의 무실점 기여는 평점의 무실점 가산(`matchRating`)이 이미 세고, "클린시트
 * 몇 번"이 묻는 것은 골문에 선 사람의 수다. 두 시뮬이 이 한 함수를 지난다.
 */
export function keptCleanSheet(input: {
  group: PositionGroup;
  conceded: number;
  minutes: number;
}): boolean {
  return input.group === "GK" && input.conceded === 0 && input.minutes >= CLEAN_SHEET_MINUTES;
}

/**
 * 한 경기가 시즌 행에 얹는 몫 — 빠진 칸은 0이다.
 *
 * `apps`가 값인 이유는 **연장** 때문이다: 출전은 90분에 이미 섰으므로 연장이 얹는
 * 몫은 `apps: 0`이고 분·슛·골만 더해진다 (match.md §6).
 */
export interface SeasonStatDelta {
  apps: number;
  goals: number;
  assists: number;
  ratingSum: number;
  minutes: number;
  shots: number;
  xg: number;
  saves: number;
  cleanSheets: number;
  yellows: number;
  reds: number;
}

/**
 * 한 경기 몫을 시즌 행에 얹는다 — **실시간 경기와 간이 시뮬이 같은 문을 쓴다**
 * (→ docs/match/match.md §6·§7). 두 벌로 두면 리그 리더보드가 감독의 경기만
 * 세는 표가 된다.
 *
 * **0인 칸은 적지 않는다** — 없는 칸이 0이라는 `SeasonStat`의 규약이 여기서 선다.
 */
export function addToSeasonStat(stat: SeasonStatTotal, delta: Partial<SeasonStatDelta>): void {
  stat.apps += delta.apps ?? 0;
  stat.goals += delta.goals ?? 0;
  if (delta.assists) stat.assists = (stat.assists ?? 0) + delta.assists;
  if (delta.ratingSum) stat.ratingSum = (stat.ratingSum ?? 0) + delta.ratingSum;
  if (delta.minutes) stat.minutes = (stat.minutes ?? 0) + delta.minutes;
  if (delta.shots) stat.shots = (stat.shots ?? 0) + delta.shots;
  if (delta.xg) stat.xg = (stat.xg ?? 0) + delta.xg;
  if (delta.saves) stat.saves = (stat.saves ?? 0) + delta.saves;
  if (delta.cleanSheets) stat.cleanSheets = (stat.cleanSheets ?? 0) + delta.cleanSheets;
  if (delta.yellows) stat.yellows = (stat.yellows ?? 0) + delta.yellows;
  if (delta.reds) stat.reds = (stat.reds ?? 0) + delta.reds;
}

/**
 * 대회 행 여럿을 **한 행처럼 접는다** — 시즌 합계는 저장하지 않고 여기서 나온다
 * (→ docs/common/game-state.md §5 파생). 행이 없으면 null: 0으로 채운 행과 "기록
 * 없음"은 다르다.
 *
 * ⚠️ **낸 행은 읽기 전용이다.** 쌓는 자리는 언제나 `ensureSeasonStat` 하나이므로
 * 여기서 낸 행에 값을 얹으면 다음 파생에서 사라지고, 행이 하나뿐이면 **그 행을 그대로
 * 낸다**(합계를 새로 짓지 않는다).
 *
 * 등번호·이름은 **마지막으로 적힌 행의 것**이다. 시즌 중에 바뀌면 마지막 값이 그
 * 시즌의 값이라는 `ensureSeasonStat`의 규약을 대회 행 여럿에서도 그대로 잇는다.
 */
export function sumSeasonStats(rows: readonly SeasonStat[]): SeasonStatTotal | null {
  const first = rows[0];
  if (first === undefined) return null;
  if (rows.length === 1) return first;
  const total: SeasonStatTotal = {
    gamePlayerId: first.gamePlayerId,
    season: first.season,
    teamId: first.teamId,
    apps: 0,
    goals: 0,
  };
  for (const row of rows) {
    addToSeasonStat(total, {
      apps: row.apps,
      goals: row.goals,
      assists: row.assists,
      ratingSum: row.ratingSum,
      minutes: row.minutes,
      shots: row.shots,
      xg: row.xg,
      saves: row.saves,
      cleanSheets: row.cleanSheets,
      yellows: row.yellows,
      reds: row.reds,
    });
    if (row.reserveApps) total.reserveApps = (total.reserveApps ?? 0) + row.reserveApps;
    if (row.reserveGoals) total.reserveGoals = (total.reserveGoals ?? 0) + row.reserveGoals;
    if (row.reserveAssists) total.reserveAssists = (total.reserveAssists ?? 0) + row.reserveAssists;
    if (row.reserveRatingSum)
      total.reserveRatingSum = (total.reserveRatingSum ?? 0) + row.reserveRatingSum;
    if (row.squadNumber !== undefined) total.squadNumber = row.squadNumber;
    if (row.playerName !== undefined) total.playerName = row.playerName;
  }
  return total;
}

/**
 * 행 묶음에서 **대회별로 세울 수 있는 1군 줄만** 골라 정렬한다 — 많이 뛴 대회부터,
 * 같으면 대회 id 사전순 (→ docs/common/game-state.md §3.4).
 *
 * 선수 카드(GM)와 스쿼드 상세(화면)가 이 한 함수를 지난다 — 두 벌로 두면 채팅에서
 * 듣는 대회별 줄과 표의 줄이 다른 규칙으로 서고 갈린다.
 *
 * ⚠️ **두 종류의 행이 빠진다.** 출전 0인 행("0경기 0골"은 줄이 아니다)과 2군 리그
 * 행(1군의 줄이 아니다 — `reserve*` 칸은 시즌 합계가 따로 낸다)이다.
 */
export function competitionRowsOf(rows: readonly SeasonStat[]): SeasonStat[] {
  return rows
    .filter((s) => s.apps > 0 && !s.competitionId.startsWith(RESERVE_COMPETITION_PREFIX))
    .sort((a, b) => b.apps - a.apps || (a.competitionId < b.competitionId ? -1 : 1));
}

/**
 * 시즌 평균 평점 — 출전이 없으면 null(0.0과 "기록 없음"은 다르다).
 * 경기당 평점은 engine/match/ratings.ts가 장부 사실로 결정적으로 매긴다.
 */
export function seasonRating(
  stat: Pick<SeasonStat, "apps" | "ratingSum"> | null | undefined,
): number | null {
  if (!stat || stat.apps <= 0 || stat.ratingSum === undefined) return null;
  return Math.round((stat.ratingSum / stat.apps) * 100) / 100;
}

// ── 리그 리더보드 ──────────────────────────────────────

/**
 * 개인 순위의 축 — 시즌 기록표(`SeasonStat`)에서 바로 나오는 다섯이다
 * (→ docs/match/competition.md §2 「개인 순위」).
 *
 * 표를 만드는 곳(engine/competition/leaderboard.ts)과 그것을 세우는 곳(대회 화면·
 * `get_league`)이 같은 열쇠를 써야 열이 하나 늘 때 한 자리만 고치면 된다.
 */
export const LEADERBOARD_KEYS = ["goals", "assists", "rating", "cleanSheets", "cards"] as const;

export type LeaderboardKey = (typeof LEADERBOARD_KEYS)[number];

/**
 * 축의 이름 — **코드에서 만든다.** 세이브에도 뷰에도 코드만 남고 표시명은 읽는
 * 자리에서 붙는다 (`awardTitle`과 같은 규약 — overview.md §1 철칙 4).
 */
export const LEADERBOARD_TITLE: Record<LeaderboardKey, string> = {
  goals: "득점",
  assists: "도움",
  rating: "평점",
  cleanSheets: "클린시트",
  cards: "징계",
};

export function leaderboardTitle(key: LeaderboardKey): string {
  return LEADERBOARD_TITLE[key];
}

/**
 * 퇴장 한 장이 경고 몇 장 몫인가 — 잉글랜드 협회의 징계 점수와 같은 눈금이다.
 *
 * 장수만 세면 퇴장이 경고와 같은 무게로 서고, 경고만 세면 퇴장 한 번이 표에서
 * 사라진다.
 */
export const RED_CARD_POINTS = 3;

/** 징계 점수 — 경고 1점 · 퇴장 `RED_CARD_POINTS`점 (competition.md §2) */
export function disciplinePoints(stat: Pick<SeasonStat, "yellows" | "reds">): number {
  return (stat.yellows ?? 0) + (stat.reds ?? 0) * RED_CARD_POINTS;
}

// ── 그 경기의 최우수 선수 ──────────────────────────────
/** 한 경기가 남긴 그 선수의 값 — MOTM 사슬이 보는 전부다 */
export interface MotmCandidate {
  id: string;
  /** 평점이 없으면 후보가 아니다 (`motmOf`가 먼저 거른다) */
  rating: number | null;
  goals: number;
  assists: number;
  /** 출전 분 — 모르는 자리는 전원 0을 주면 이 칸에서 갈리지 않는다 */
  minutes: number;
}

/**
 * 그 경기 최우수 선수의 **동점 사슬** — 평점 ↓ → 골 ↓ → 도움 ↓ → 출전 분 ↓ →
 * `id` 사전순 ↑. 앞선 쪽이 음수다.
 *
 * 경기 리포트의 MOTM(engine/views `motmOf`)과 대회의 **결승 MOM** 시상
 * (engine/competition/season.ts — season.md §6)이 이 한 사슬을 쓴다. 두 벌로 두면
 * 같은 결승의 최우수 선수가 화면과 시상에서 다른 사람이 된다.
 *
 * 마지막 칸이 id인 것은 뜻이 아니라 결정성을 위한 것이다 — 네 칸까지 같은 두 선수가
 * 화면을 열 때마다 번갈아 뽑히면 그건 판정이 아니다.
 */
export function compareMotm(a: MotmCandidate, b: MotmCandidate): number {
  return (
    (b.rating ?? 0) - (a.rating ?? 0) ||
    b.goals - a.goals ||
    b.assists - a.assists ||
    b.minutes - a.minutes ||
    a.id.localeCompare(b.id)
  );
}

/** 사슬로 한 명을 고른다 — 평점이 없는 사람은 후보가 아니다 */
export function pickMotm<T extends MotmCandidate>(players: readonly T[]): T | null {
  let best: T | null = null;
  for (const p of players) {
    if (p.rating === null) continue;
    if (!best || compareMotm(p, best) < 0) best = p;
  }
  return best;
}

// ── 마일스톤 ──────────────────────────────────────────
/**
 * 그 경기가 세운 기록 — **코드와 수치뿐이다.** 문장은 읽는 쪽이 만든다
 * (→ docs/match/match.md §6 · overview.md §1 철칙 4).
 *
 * ⚠️ **클럽 단위다.** 원장은 게임 시작 뒤의 출전만 알고 부임 전 커리어는 시드에
 * 없으므로, 통산 문턱을 세우면 코어가 사실이 아닌 것을 사실로 낸다. 클럽 안의 수는
 * 전부 원장 안에 있어 정직하다.
 */
export const MILESTONE_CODES = ["debut", "first-goal", "apps", "goals", "hat-trick"] as const;

export type MilestoneCode = (typeof MILESTONE_CODES)[number];

/**
 * 문턱 — 리그·컵·유럽을 합쳐 한 시즌이 40~50경기라 50은 한 시즌 남짓, 100은 두세
 * 시즌이다. 득점의 25는 최상급 공격수의 한 시즌치. 더 촘촘하면 회견이 매주
 * 시상식이 되고, 더 성기면 3년을 함께한 주장에게 아무 일도 일어나지 않는다.
 */
export const MILESTONE_APP_STEPS = [50, 100, 200, 300, 400, 500] as const;

export const MILESTONE_GOAL_STEPS = [25, 50, 100, 150, 200] as const;

/** 한 경기에 몇 골부터 해트트릭인가 */
export const HAT_TRICK_GOALS = 3;

export const MilestoneSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 어느 셔츠로 세운 기록인가 — 문턱은 이 팀 안에서만 센다 */
  teamId: z.string().min(1),
  matchId: z.string().min(1),
  season: z.number().int(),
  date: DateString,
  code: z.enum(MILESTONE_CODES),
  /** 눈금 — 경기·골은 넘은 문턱, 해트트릭은 그 경기의 골 수, 데뷔·첫 골은 1 */
  value: z.number().int().min(1),
});

export type Milestone = z.infer<typeof MilestoneSchema>;

/**
 * 드문 순서 — 한 경기가 여럿을 세우면 **회견에 오르는 것은 하나**이고 이 순서가
 * 그것을 고른다 (people.md §4). 큰 수일수록 앞이므로 같은 코드 안에서는 값으로 갈린다.
 */
export const MILESTONE_RARITY: Record<MilestoneCode, number> = {
  goals: 4,
  apps: 3,
  "hat-trick": 2,
  "first-goal": 1,
  debut: 0,
};

/**
 * 둘 중 어느 쪽이 더 드문가 — 음수면 `a`가 앞이다 (정렬 비교자).
 * 코드와 값만 본다 — 장부에 적히기 전의 판정 결과도 같은 자로 세운다.
 */
export function compareMilestones(
  a: Pick<Milestone, "code" | "value">,
  b: Pick<Milestone, "code" | "value">,
): number {
  return MILESTONE_RARITY[b.code] - MILESTONE_RARITY[a.code] || b.value - a.value;
}

/**
 * 마일스톤의 **라벨** — "데뷔전"·"100경기"까지가 코어의 말이고, 그것을 문장에
 * 앉히는 것은 회견 카드(`pressFactText`)와 화면의 몫이다.
 */
export function milestoneTitle(code: MilestoneCode, value: number): string {
  switch (code) {
    case "debut":
      return "데뷔전";
    case "first-goal":
      return "첫 골";
    case "apps":
      return `${value}경기`;
    case "goals":
      return `${value}골`;
    case "hat-trick":
      return value > HAT_TRICK_GOALS ? `한 경기 ${value}골` : "해트트릭";
  }
}

/**
 * 라벨에 **어느 범위의 수인가**를 붙인 말 — "구단 통산 100경기".
 *
 * 문턱은 클럽 안의 수인데(match.md §6) "100경기"만 적으면 읽는 쪽이 통산으로 읽고,
 * 원장에 없는 부임 전 커리어를 이야기에 지어 넣는다. 이 말을 회견 카드·경기 말풍선·
 * 서사 메모·심경의 사실 줄이 함께 쓴다 — **네 곳이 각자 접두를 붙이면** 어느 하나를
 * 고친 날 나머지 셋이 다른 말을 한다.
 */
export function milestonePhrase(code: MilestoneCode, value: number): string {
  const title = milestoneTitle(code, value);
  return code === "apps" || code === "goals" ? `구단 통산 ${title}` : title;
}
