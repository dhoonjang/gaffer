import { z } from "zod";

// ── 시상 ──────────────────────────────────────────────
/**
 * 시상 코드 — **세이브에 남는 것은 이 코드와 근거 수치뿐이다**
 * (overview.md §1 철칙 4 · `AchievementCode`와 같은 규약).
 *
 * 표시명("올해의 선수")도 평가 문장("빛나는 시즌이었다")도 적지 않는다. 이름은
 * `awardTitle`이 코드에서 만들고, 문장은 GM(장면)과 화면(커리어 표)이 쓴다.
 * 선정과 동점 처리 규칙은 simulation/season.md §6이 원본이다.
 *
 * ⚠️ **대회마다 코드를 늘리지 않는다.** 「UCL 득점왕」도 코드는 `top-scorer`이고
 * 어느 대회의 상인지는 `SeasonAward.competitionId`가 갖는다 — 코드를 늘리면
 * 화면·프롬프트·커리어 표가 저마다 표를 하나씩 더 들고, 새 컵이 서는 날 그 넷이
 * 같이 늘어난다.
 */
export const SEASON_AWARD_CODES = [
  /** 그 대회 최다 득점 — 리그에도 컵·대항전에도 선다 */
  "top-scorer",
  /** 최다 도움 — 리그의 상이다 */
  "top-assister",
  /** 출전 문턱을 넘은 선수 중 시즌 평점 1위 — 리그의 상이다 */
  "player-of-season",
  /** 같은 눈금, 시즌 종료일 기준 `YOUNG_PLAYER_MAX_AGE`세 이하 — 리그의 상이다 */
  "young-player",
  /**
   * 그 대회 **결승 한 경기**의 평점 1위 — 컵·대항전의 상이다.
   * 근거 수치도 그 경기의 것이라 `apps`는 언제나 1이다 (season.md §6).
   */
  "final-motm",
] as const;

export type SeasonAwardCode = (typeof SEASON_AWARD_CODES)[number];

/** 영플레이어의 나이 상한 — 시즌 종료일 기준 만 나이 */
export const YOUNG_PLAYER_MAX_AGE = 23;

/** 코드 → 상의 이름. 코드가 그 자리에서 읽히게 하는 유일한 표 */
export const SEASON_AWARD_TITLES: Record<string, string> = {
  "top-scorer": "득점왕",
  "top-assister": "도움왕",
  "player-of-season": "올해의 선수",
  "young-player": "영플레이어",
  "final-motm": "결승 MOM",
};

export function awardTitle(code: string): string {
  return SEASON_AWARD_TITLES[code] ?? code;
}

/**
 * 상이 선 **근거 수치 한 조각** — 「38경기 25골」·「결승 · 평점 8.20 · 1골」.
 *
 * 상마다 읽는 칸이 다르다: 득점왕은 골, 도움왕은 도움, 영플레이어는 나이, 결승 MOM은
 * **그 한 경기**다(출전 수를 적으면 「1경기」가 되어 사실을 흐린다 — season.md §6).
 *
 * ⚠️ **이 조각은 한 벌이다.** 시즌 다이제스트의 줄(`awardLine`)과 회견·다가옴의 사실
 * 카드(`pressFactText`의 `award`)가 같은 함수를 부른다 — 자리마다 제 문구를 쓰면 같은
 * 상이 결산 화면과 회견에서 다른 말로 선다 (season.md §6 「상이 사실로 서는 자리」).
 */
export function awardDetail(
  a: Pick<SeasonAward, "code" | "apps" | "goals" | "assists"> &
    Partial<Pick<SeasonAward, "rating" | "age">>,
): string {
  const rating = a.rating === undefined ? "" : ` · 평점 ${a.rating.toFixed(2)}`;
  if (a.code === "final-motm") {
    const scored = [a.goals > 0 ? `${a.goals}골` : null, a.assists > 0 ? `${a.assists}도움` : null]
      .filter((x) => x !== null)
      .join(" ");
    return `결승${rating}${scored === "" ? "" : ` · ${scored}`}`;
  }
  if (a.code === "top-scorer") return `${a.apps}경기 ${a.goals}골`;
  if (a.code === "top-assister") return `${a.apps}경기 ${a.assists}도움`;
  // 나이를 모르는 줄(카드의 빈 칸)은 「만 undefined세」 대신 나이를 빼고 선다
  if (a.code === "young-player" && a.age !== undefined) {
    return `만 ${a.age}세 · ${a.apps}경기${rating}`;
  }
  return `${a.apps}경기${rating}`;
}

/**
 * 시상 한 건 — 코드 + **그 상이 선 근거 수치**.
 *
 * 수상자 **이름**을 함께 적는 것은 그것이 사실이라서다 — 은퇴하면
 * `state.players`에서 사라져 id로는 더 못 찾는다 (`Achievement.playerName`과 같은 이유).
 */
export const SeasonAwardSchema = z.object({
  code: z.string().min(1),
  season: z.number().int(),
  /**
   * **어느 대회의 상인가** — 리그 id 또는 컵·대항전 id. 코드가 아니라 이 칸이
   * 「UCL 득점왕」과 「리그 득점왕」을 가른다 (season.md §6).
   */
  competitionId: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 그때의 이름 */
  playerName: z.string().min(1),
  /** 그 대회에서 가장 많이 뛴 팀 */
  teamId: z.string().min(1),
  /** 근거 수치 — 어느 칸을 채우는가는 코드가 정한다 */
  apps: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
  assists: z.number().int().nonnegative(),
  /** 시즌 평점 — 출전이 없으면 없다 (`seasonRating`과 같은 눈금) */
  rating: z.number().optional(),
  /** `young-player`가 센 나이 — 시즌 종료일 기준 */
  age: z.number().int().positive().optional(),
});

export type SeasonAward = z.infer<typeof SeasonAwardSchema>;
