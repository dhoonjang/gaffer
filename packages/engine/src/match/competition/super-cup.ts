import { type SuperCupEntry, SUPER_CUP_CATALOG } from "../../common/data/super-cup-catalog";
import { addDays } from "../../common/core/dates";
import { buildSeasonCalendar } from "../../common/core/calendar";
import { cupCatalog } from "../../common/data/cup-catalog";
import { topLeagueOfCountry } from "../../common/data/league-catalog";
import { domesticCupsOfCountry } from "../../common/data/domestic-cup-catalog";
import { type MatchRecord, cupLegMatchId } from "@story-fm/domain";
import { type GameState } from "../../common/core/state";
import { settledTieWinner } from "./extra-time";

/**
 * 슈퍼컵 — 지난 시즌의 우승자가 프리시즌에 여는 한 경기.
 *
 * 라운드가 없으므로 진행형 상태 기계도 없다. 시즌 편성이 경기 하나를 만들어 두고
 * (`buildSuperCupMatches`), 그 경기가 끝나면 여기서 승부를 가려 트로피와 상금을
 * 낸다(`advanceSuperCups`). 국내 컵·대항전의 `advance*`와 같은 자리에서 불린다.
 *
 * 대진은 카탈로그가 아니라 **지난 시즌의 사실**에서 온다 — 리그 최종 순위·국내 컵
 * 우승·대항전 우승. 그래서 시즌 전환이 그 셋을 지우기 **전에** 읽어 넘겨야 한다
 * (`SuperCupSource` — season.ts의 `applyTransition`).
 */

/** 개막 토요일에서 며칠 앞인가 — 국내는 두 주 앞 수요일, 유럽은 개막 주 수요일 */
const DOMESTIC_DAYS_BEFORE_OPENER = -10;

const EUROPEAN_DAYS_BEFORE_OPENER = -3;

/**
 * 두 슈퍼컵이 **다른 수요일**에 서는 이유: 한 클럽이 둘 다 나올 수 있다 (UCL
 * 우승팀이 자기 리그 우승팀이기도 한 흔한 경우). 같은 날에 두면 그 클럽의 경기
 * 하나가 영영 소화되지 않고 시즌이 넘어가지 않는다.
 *
 * 수요일인 이유는 친선이 토요일에만 서기 때문이다 (season.md §2) — 앞뒤로 사흘씩
 * 남고, 개막 주 수요일과 금요일 밤 개막전 사이도 48시간이 채워진다.
 */
const SUPER_CUP_KICKOFF = "19:45";

/** 한 경기뿐이라 단계는 언제나 결승, 대진도 하나다 */
const SUPER_CUP_PAIR = 0;

/**
 * 지난 시즌이 남긴 우승자 — 대진의 원본.
 *
 * 리그는 **최종 순위표 전체**를 받는다. 우승팀이 컵도 가져간 시즌엔 준우승팀이
 * 상대이기 때문이다(실제 커뮤니티 실드·DFL-슈퍼컵 규정).
 */
export interface SuperCupSource {
  /** 리그 최종 순위 — `leagueId` → 1위부터 나열한 팀 id */
  leagueTables: Record<string, string[]>;
  /** 국내 컵 우승 — `cupId` → 팀 id */
  domesticChampions: Record<string, string>;
  /** 대항전 우승 — `cupId` → 팀 id */
  euroChampions: Record<string, string>;
}

/** 이 슈퍼컵이 서는 날 — 개막 토요일에서 거꾸로 센다 */
export function superCupDate(season: number, kind: SuperCupEntry["kind"]): string {
  // `calendar.start`는 금요일 밤 개막전이고, 그 다음 날이 개막 토요일이다
  const openerSaturday = addDays(buildSeasonCalendar(season).start, 1);
  return addDays(
    openerSaturday,
    kind === "european" ? EUROPEAN_DAYS_BEFORE_OPENER : DOMESTIC_DAYS_BEFORE_OPENER,
  );
}

/** 한 대회의 대진 — 두 자리가 다 차지 않으면 그 슈퍼컵은 그해 서지 않는다 */
function pairingOf(cup: SuperCupEntry, source: SuperCupSource): [string, string] | null {
  if (cup.kind === "european") {
    /**
     * **대항전 카탈로그의 위 두 대회** 우승자가 만난다 — UCL 우승 vs UEL 우승이다.
     * id를 박아 두지 않는 이유: 대회 이름이 바뀌어도 "1군과 2군 대회의 우승자"라는
     * 규정은 그대로다.
     */
    const [first, second] = cupCatalog();
    if (!first || !second) return null;
    const home = source.euroChampions[first.id];
    const away = source.euroChampions[second.id];
    return home && away && home !== away ? [home, away] : null;
  }

  const country = cup.country;
  if (country === undefined) return null;
  const leagueId = topLeagueOfCountry(country);
  const majorCup = domesticCupsOfCountry(country)[0];
  if (!leagueId || !majorCup) return null;
  const ranked = source.leagueTables[leagueId] ?? [];
  const champion = ranked[0];
  const cupWinner = source.domesticChampions[majorCup.id];
  if (!champion || !cupWinner) return null;
  // 더블을 한 시즌엔 리그 준우승팀이 상대다 (실제 규정)
  const challenger = cupWinner === champion ? ranked[1] : cupWinner;
  return challenger ? [champion, challenger] : null;
}

/**
 * 이번 시즌 슈퍼컵 경기 — 지난 시즌 우승자가 있는 대회만.
 *
 * 첫 시즌은 지난 시즌이 없으므로 `source`가 널이고 한 경기도 서지 않는다.
 * 명목상 홈은 리그 우승팀(유럽은 UCL 우승팀)이지만 **전 경기 중립**이라 홈 이점은
 * 없다 — 홈/원정은 장부의 자리일 뿐이다.
 */
export function buildSuperCupMatches(season: number, source: SuperCupSource | null): MatchRecord[] {
  if (!source) return [];
  const matches: MatchRecord[] = [];
  for (const cup of SUPER_CUP_CATALOG) {
    const pairing = pairingOf(cup, source);
    if (!pairing) continue;
    const [homeTeamId, awayTeamId] = pairing;
    matches.push({
      id: cupLegMatchId({
        cupId: cup.id,
        season,
        stage: "final",
        pair: SUPER_CUP_PAIR,
        leg: 1,
      }),
      season,
      competitionId: cup.id,
      stage: "final",
      round: 1,
      date: superCupDate(season, cup.kind),
      time: SUPER_CUP_KICKOFF,
      neutral: true,
      homeTeamId,
      awayTeamId,
      result: null,
    });
  }
  return matches;
}

/** 이번 시즌 이 슈퍼컵의 경기 — 안 열린 대회면 널 */
export function superCupMatch(state: GameState, cupId: string): MatchRecord | null {
  return state.matches.find((m) => m.season === state.season && m.competitionId === cupId) ?? null;
}

/** 이 슈퍼컵의 우승 팀 — 승부가 갈렸을 때만 (읽기만 한다) */
export function superCupChampion(state: GameState, cupId: string): string | null {
  const match = superCupMatch(state, cupId);
  return match ? settledTieWinner([match]) : null;
}
