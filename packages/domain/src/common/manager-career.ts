import { z } from "zod";
import { ClubTierSchema } from "./team";

export const SeasonRecordSchema = z.object({
  season: z.number().int(),
  /** 재임 팀 — 감독이 팀을 옮겨도 기록이 유지된다 */
  teamId: z.string().min(1),
  position: z.number().int().min(1),
  wins: z.number().int().min(0),
  draws: z.number().int().min(0),
  losses: z.number().int().min(0),
  goalsFor: z.number().int().min(0),
  goalsAgainst: z.number().int().min(0),
  tier: ClubTierSchema,
  /**
   * 그 시즌에 뛴 리그 — 승강이 생기면서 필요해졌다. 순위만으로는 챔피언십 1위와
   * 프리미어리그 1위를 가를 수 없어 성적 수당이 잘못 붙는다.
   */
  leagueId: z.string().min(1),
});

export type SeasonRecord = z.infer<typeof SeasonRecordSchema>;

/**
 * 트로피 — **대회 id로 남긴다** (career.md §6).
 *
 * 대회 이름은 카탈로그가 갖고 어드민이 고칠 수 있다. 표시 이름을 박아 두면 이름을
 * 고친 뒤의 우승과 그 전의 우승이 보관함에 다른 대회로 서고, id가 없으니 되돌릴
 * 길도 없다. 업적(`Achievement`)이 이미 id로 남는 것과 같은 규약이다.
 */
export const TrophySchema = z.object({
  season: z.number().int(),
  /** 대회 id — 리그 우승이면 리그 id */
  competitionId: z.string().min(1),
  /** 우승 팀 */
  teamId: z.string().min(1),
  /**
   * 결승에서 진 팀 — **준우승은 그 우승이 누구를 꺾은 것인가라는 사실**이라 같은 줄에
   * 선다. 리그에는 결승이 없어 비고(그 시즌 2위는 순위표의 2위다).
   */
  runnerUpTeamId: z.string().min(1).optional(),
});

export type Trophy = z.infer<typeof TrophySchema>;

/**
 * 업적 코드 — **세이브에 남는 것은 이 코드와 근거 수치뿐이다** (overview.md §1 철칙 4).
 *
 * 이름과 설명 문장을 함께 저장하면 문구를 고쳐도 지난 시즌의 줄은 옛 문장 그대로다.
 * 화면과 `get_career`는 코드로 이름을 얻고(`achievementTitle`) 문장은 수치로 쓴다.
 */
export const ACHIEVEMENT_CODES = [
  "champion",
  "invincible",
  "ucl-spot",
  "sharpshooter",
  "survivor",
  "cup-winner",
  "euro-champion",
] as const;

export type AchievementCode = (typeof ACHIEVEMENT_CODES)[number];

/** 업적 이름 — 코드가 그 자리에서 읽히게 하는 유일한 표 (career.md §6) */
export const ACHIEVEMENT_TITLES: Record<AchievementCode, string> = {
  champion: "챔피언",
  invincible: "무패 시즌",
  "ucl-spot": "유럽 최상위 진출",
  sharpshooter: "골잡이 조련사",
  survivor: "생존왕",
  "cup-winner": "컵 우승",
  "euro-champion": "유럽 정복",
};

export function achievementTitle(code: AchievementCode): string {
  return ACHIEVEMENT_TITLES[code];
}

/**
 * 업적 한 건 — 코드 + **그 업적이 선 근거 수치**. 어느 항목을 채우는가는 코드가 정한다
 * (career.md §6).
 */
export const AchievementSchema = z.object({
  code: z.enum(ACHIEVEMENT_CODES),
  season: z.number().int(),
  /** 리그 성적에서 나온 업적의 근거 — 최종 순위와 그 시즌에 뛴 리그 */
  position: z.number().int().positive().optional(),
  leagueId: z.string().min(1).optional(),
  /** `invincible`이 센 경기 수 — 리그 규모마다 다르다 */
  matches: z.number().int().positive().optional(),
  /** `cup-winner`·`euro-champion`이 가리키는 대회 */
  competitionId: z.string().min(1).optional(),
  /**
   * `sharpshooter`의 그 선수와 시즌 골. 이름을 함께 남기는 이유는 은퇴한 선수가
   * `state.players`에서 사라져 id로는 더 못 찾기 때문이다 — 이름은 사실이지 문장이 아니다.
   */
  gamePlayerId: z.string().min(1).optional(),
  playerName: z.string().min(1).optional(),
  goals: z.number().int().nonnegative().optional(),
});

export type Achievement = z.infer<typeof AchievementSchema>;
