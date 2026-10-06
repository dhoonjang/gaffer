import {
  type SeasonHistory,
  type SeasonStat,
  josa,
  josaOf,
  competitionRowsOf,
  naturalPositionOf,
} from "@gaffer/domain";
import { rankByName } from "../../core/name-match";
import { careerOf, type CareerTotals } from "../../players/career";
import { competitionName, competitionShortName } from "../../core/catalog/cup-catalog";
import { competitionHint, resolveCompetitionId } from "../../team/player-pool";
import { awardLine } from "../../season/awards";
import {
  clubHonoursLine,
  clubRecordsOf,
  pastSeasonsOf,
  seasonHistoryOf,
  seasonLabelOf,
} from "../../season/records";
import { teamNameIn, teamShortNameIn, type GameState } from "../../core/state";
import {
  type LookupResult,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  resolveTeam,
  competitionStatText,
} from "./resolve";
import { careerStatText } from "./player-card";
import {
  seasonLabel,
  leagueOfTeamInSeason,
  trophyOf,
  championText,
  pastCompetitionView,
} from "./league";

// ── 역대 (지나간 시즌 · 구단 역사 · 선수 통산) ──────────

/**
 * 세계의 기억을 읽는 자리 — **장부에 남은 것만** 답한다 (game-state.md §3.3).
 *
 * 시즌이 넘어가면 경기는 사라지고 표가 남는다: 리그별 최종 순위표(`state.history`),
 * 전 구단의 우승(`TROPHY` + 카탈로그 `honours`), 그리고 **감독 팀의 경기**뿐이다.
 * 남의 팀끼리의 지난 시즌 스코어는 없고, 그 물음에는 없다고 말한다 — 답할 도구가
 * 조용히 빈 답을 주면 모델이 지어낸다.
 */
interface HistoryViewInput {
  /** 시즌 번호 — 주면 그 시즌 하나를 본다 */
  season?: number | undefined;
  /** 대회 이름·약어·id — `season`과 함께면 그 시즌 그 대회의 결과다 */
  competition?: string | undefined;
  /** 구단 이름·약칭·id — `season` 없이 주면 그 구단의 역대 기록이다 */
  team?: string | undefined;
  /** 선수 이름 또는 id — 은퇴한 선수도 찾는다 */
  player?: string | undefined;
  /** 목록의 최대 행 수 (기본 8) — 순위표는 자르지 않는다 */
  count?: number | undefined;
}

/** 그 시즌 감독 팀의 성적 한 줄 — 그 팀이 리그 표에 없으면 서지 않는다 */
function ourSeasonLine(state: GameState, snapshot: SeasonHistory): string | null {
  const teamId = snapshot.teamId;
  for (const league of snapshot.leagues) {
    const index = league.rows.findIndex((r) => r.teamId === teamId);
    if (index < 0) continue;
    const record = league.rows[index]!.record;
    return (
      `우리: ${teamNameIn(state, teamId)} ${competitionShortName(league.leagueId)} ${index + 1}위` +
      ` · ${record.played}경기 ${record.wins}승 ${record.draws}무 ${record.losses}패` +
      ` · 승점 ${record.points} (득 ${record.goalsFor} 실 ${record.goalsAgainst})` +
      (snapshot.matches.length > 0 ? ` · 장부에 남은 경기 ${snapshot.matches.length}건` : "")
    );
  }
  return null;
}

/**
 * 그 시즌의 우승자 전부 — **리그는 표의 1위, 녹아웃은 트로피**다 (§3.3).
 * 리그 우승도 트로피 원장에 한 줄이 있으므로 표가 이미 답한 대회는 다시 세우지 않는다.
 */
function championLines(state: GameState, snapshot: SeasonHistory): string[] {
  const fromTable = snapshot.leagues
    .map((league) => {
      const champion = league.rows[0];
      return champion === undefined
        ? null
        : `  ${competitionName(league.leagueId)} — ${teamNameIn(state, champion.teamId)}`;
    })
    .filter((line): line is string => line !== null);
  const covered = new Set(snapshot.leagues.map((l) => l.leagueId));
  const fromTrophies = state.trophies
    .filter((t) => t.season === snapshot.season && !covered.has(t.competitionId))
    .map((t) => `  ${competitionName(t.competitionId)} — ${championText(state, t)}`)
    .sort();
  return [...fromTable, ...fromTrophies];
}

/** 지나간 시즌 한 줄 — 시즌·우리 순위·리그 챔피언 */
function pastSeasonLine(state: GameState, snapshot: SeasonHistory): string {
  const ourLeague =
    snapshot.leagues.find((l) => l.rows.some((r) => r.teamId === snapshot.teamId)) ?? null;
  const ours =
    ourLeague === null
      ? ""
      : ` ${teamShortNameIn(state, snapshot.teamId)} ${competitionShortName(ourLeague.leagueId)} ` +
        `${ourLeague.rows.findIndex((r) => r.teamId === snapshot.teamId) + 1}위`;
  // 감독의 팀이 리그 표에 없는 시즌(커리어 끝·리그 밖)도 표의 1위는 안다 — 그 표의 챔피언을 세운다
  const league = ourLeague ?? snapshot.leagues[0];
  const champion = league?.rows[0];
  const crown =
    league === undefined || champion === undefined
      ? ""
      : ` · ${competitionShortName(league.leagueId)} 챔피언 ${teamNameIn(state, champion.teamId)}`;
  return `  시즌 ${snapshot.season} (${seasonLabelOf(snapshot.season)})${ours}${crown}`;
}

/**
 * 그 구단의 역대 — 전부 `clubRecordsOf` 하나에서 나온다 (career.md §6).
 * 우승 줄은 시드가 없고 게임 안의 우승도 없으면 서지 않는다: **없는 것은 0회가
 * 아니라 모르는 것이다** (team.md §1).
 */
function clubHistoryView(state: GameState, teamId: string, limit: number): LookupResult {
  const records = clubRecordsOf(state, teamId);
  const honours = clubHonoursLine(state, teamId);
  const at = (best: { season: number; leagueId: string }) =>
    `(시즌 ${best.season} · ${competitionShortName(best.leagueId)})`;
  const lines = [
    `[역대] ${teamNameIn(state, teamId)} — 장부가 아는 ${records.seasons}시즌 · 오늘 ${state.date}`,
    ...(honours === null ? [] : [`우승: ${honours}`]),
    ...(records.bestPoints === null
      ? []
      : [`한 시즌 최다 승점: ${records.bestPoints.value}점 ${at(records.bestPoints)}`]),
    ...(records.mostGoals === null
      ? []
      : [`한 시즌 최다 득점: ${records.mostGoals.value}골 ${at(records.mostGoals)}`]),
    ...(records.bestPosition === null
      ? []
      : [`역대 최고 순위: ${records.bestPosition.value}위 ${at(records.bestPosition)}`]),
  ];
  if (records.awards.length > 0) {
    const shown = records.awards.slice(0, limit);
    lines.push(
      `이 구단 소속의 시상 ${records.awards.length}건:`,
      ...shown.map((a) => `  시즌 ${a.season} ${awardLine(a)}`),
    );
    if (records.awards.length > shown.length) {
      lines.push(`  …그 외 ${records.awards.length - shown.length}건`);
    }
  }
  if (lines.length === 1) {
    lines.push(`장부에 남은 기록이 없습니다 — 지나간 시즌도 우승도 아직 없습니다`);
  }
  return { ok: true, message: lines.join("\n") };
}

/** 역대를 물을 수 있는 사람 — 현역과 **은퇴한 사람**이 한 명부에 선다 */
interface HistoryPerson {
  id: string;
  name: string;
  note: string;
}

/**
 * 이름으로 사람을 찾는다 — 은퇴하면 `state.players`에서 빠지므로 명부(`state.retired`)도
 * 함께 뒤진다. 역대 득점왕을 물었는데 그 사람이 그만뒀다는 이유로 못 찾으면 안 된다.
 */
function resolveHistoryPerson(state: GameState, ref: string): readonly HistoryPerson[] {
  const pool: HistoryPerson[] = [
    ...state.players.map((p) => ({
      id: p.id,
      name: p.name,
      note: `${naturalPositionOf(p).position} · ${teamShortNameIn(state, p.teamId)}`,
    })),
    ...state.retired.map((r) => ({
      id: r.gamePlayerId,
      name: r.name,
      note: `${r.position} · ${r.on} 은퇴`,
    })),
  ];
  const key = ref.trim();
  const exact = pool.find((p) => p.id === key);
  if (exact) return [exact];
  return rankByName(key, pool).matches;
}

/** 그 선수의 통산과 받은 상 — 통산은 `careerOf` 하나에서 나온다 (game-state.md §5) */
function playerHistoryView(state: GameState, person: HistoryPerson): LookupResult {
  const career = careerOf(state, person.id);
  const awards = state.awards
    .filter((a) => a.gamePlayerId === person.id)
    .sort((a, b) => b.season - a.season || a.code.localeCompare(b.code));
  const played = (t: CareerTotals) => t.apps > 0 || t.reserveApps > 0;
  const lines = [`[역대] ${person.name} (${person.note})`];
  lines.push(
    played(career.totals)
      ? `통산: ${careerStatText(career.totals)}`
      : `통산: 장부에 출전 기록이 없습니다 (게임이 시작되기 전의 커리어는 장부에 없습니다)`,
  );
  const teams = career.teams.filter(played);
  if (teams.length > 0) {
    lines.push(
      `팀별: ${teams
        .map((t) => `${teamShortNameIn(state, t.teamId)}(${t.from}~${t.to}) ${careerStatText(t)}`)
        .join(" / ")}`,
    );
  }
  const seasons = career.seasons.filter(played);
  if (seasons.length > 1) {
    /**
     * 시즌 × 팀 → 그 시즌 그 셔츠의 대회별 행 — 원장은 세계 전체의 행이라 **한 번만**
     * 훑는다. `seasonStatsByCompetitionOf`는 지금 소속의 행만 주므로 옛 셔츠의 시즌이
     * 통째로 빈다 (game-state.md §3.4).
     */
    const bySeasonTeam = new Map<string, SeasonStat[]>();
    for (const row of competitionRowsOf(
      state.seasonStats.filter((s) => s.gamePlayerId === person.id),
    )) {
      const key = `${row.season}\u0000${row.teamId}`;
      const found = bySeasonTeam.get(key);
      if (found) found.push(row);
      else bySeasonTeam.set(key, [row]);
    }
    lines.push(
      `시즌별: ${seasons
        .map((s) => {
          const rows = bySeasonTeam.get(`${s.season}\u0000${s.teamId}`) ?? [];
          // 대회가 하나면 시즌 합이 이미 그 수다 (`competitionStatLine`과 같은 규칙)
          const detail = rows.length < 2 ? "" : ` (${competitionStatText(rows)})`;
          return `${s.season} ${teamShortNameIn(state, s.teamId)} ${careerStatText(s)}${detail}`;
        })
        .join(" / ")}`,
    );
  }
  if (awards.length > 0) {
    lines.push(
      `받은 상 ${awards.length}건:`,
      // 대회 이름은 `awardLine`이 이미 앞에 세운다 (season.md §6)
      ...awards.map((a) => `  시즌 ${a.season} ${awardLine(a)}`),
    );
  }
  return { ok: true, message: lines.join("\n") };
}

/**
 * 역대 조회 — 시즌·대회·팀·선수로 좁혀 답한다.
 *
 * 좁힌 것이 없으면 지나간 시즌의 목록이 최근 것부터 온다. 절단은 언제나 남은 수를
 * 함께 알린다 (이 파일의 다른 뷰와 같은 규약) — 순위표만은 자르지 않는다: 표는
 * 잘리면 표가 아니다.
 */
export function historyView(state: GameState, input: HistoryViewInput = {}): LookupResult {
  const limit = Math.min(Math.max(input.count ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (input.player !== undefined) {
    const matches = resolveHistoryPerson(state, input.player);
    if (matches.length === 0) {
      return {
        ok: false,
        message: `"${input.player}"${josaOf(input.player, "이라는/라는")} 선수를 찾지 못했습니다`,
      };
    }
    if (matches.length > 1) {
      const names = matches
        .slice(0, 6)
        .map((p) => `${p.name}(${p.id})`)
        .join(" / ");
      return {
        ok: false,
        message: `"${input.player}"${josaOf(input.player, "은/는")} 여러 선수와 맞습니다 — ${names}`,
      };
    }
    return playerHistoryView(state, matches[0]!);
  }

  let teamId: string | null = null;
  if (input.team !== undefined) {
    const resolved = resolveTeam(state, input.team);
    if (!resolved.ok) return resolved;
    teamId = resolved.teamId;
  }

  let competitionId: string | null = null;
  if (input.competition !== undefined) {
    competitionId = resolveCompetitionId(input.competition);
    if (competitionId === null) {
      return {
        ok: false,
        message: `"${input.competition}"${josaOf(input.competition, "이라는/라는")} 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
  }

  if (input.season !== undefined) {
    const season = input.season;
    if (season >= state.season) {
      return {
        ok: true,
        message:
          `시즌 ${josa(String(season), "은/는")} 아직 지나가지 않았습니다 — 결산 스냅샷은 시즌이 넘어갈 때 남습니다.` +
          ` 진행 중인 시즌은 순위표와 일정이 답합니다`,
      };
    }
    // 대회를 주면 그 대회 하나, 팀을 주면 **그때** 그 팀이 뛴 리그의 표
    const narrowed =
      competitionId ?? (teamId === null ? null : leagueOfTeamInSeason(state, season, teamId));
    if (narrowed !== null) return pastCompetitionView(state, season, narrowed);

    const snapshot = seasonHistoryOf(state, season);
    if (snapshot === null) {
      return { ok: true, message: `시즌 ${season}의 결산이 장부에 없습니다` };
    }
    const champions = championLines(state, snapshot);
    const ours = ourSeasonLine(state, snapshot);
    return {
      ok: true,
      message: [
        `[역대] ${seasonLabel(season)} 결산`,
        ...(champions.length > 0 ? [`우승:`, ...champions] : [`우승: 장부에 남은 것이 없습니다`]),
        ...(ours === null ? [] : [ours]),
      ].join("\n"),
    };
  }

  if (teamId !== null) return clubHistoryView(state, teamId, limit);

  // 대회만 주면 그 대회의 역대 우승 — 시즌마다 한 줄이다
  if (competitionId !== null) {
    const cup = competitionId;
    const rows = pastSeasonsOf(state)
      .map((snapshot) => {
        const at = `  시즌 ${snapshot.season} (${seasonLabelOf(snapshot.season)})`;
        const champion = snapshot.leagues.find((l) => l.leagueId === cup)?.rows[0];
        if (champion) return `${at} ${teamNameIn(state, champion.teamId)}`;
        const trophy = trophyOf(state, snapshot.season, cup);
        return trophy === null ? null : `${at} ${championText(state, trophy)}`;
      })
      .filter((line): line is string => line !== null);
    if (rows.length === 0) {
      return {
        ok: true,
        message: `[역대] ${competitionName(cup)} — 장부에 지나간 시즌의 우승이 없습니다`,
      };
    }
    const shown = rows.slice(0, limit);
    return {
      ok: true,
      message: [
        `[역대] ${competitionName(cup)} 우승 ${rows.length}시즌 (최근부터)`,
        ...shown,
        ...(rows.length > shown.length ? [`  …그 외 ${rows.length - shown.length}시즌`] : []),
      ].join("\n"),
    };
  }

  const seasons = pastSeasonsOf(state);
  if (seasons.length === 0) {
    return {
      ok: true,
      message: `[역대] 장부에 지나간 시즌이 없습니다 — ${josa(seasonLabel(state.season), "이/가")} 첫 시즌입니다`,
    };
  }
  const shown = seasons.slice(0, limit);
  return {
    ok: true,
    message: [
      `[역대] 지나간 ${seasons.length}시즌 (최근부터) · 오늘 ${state.date}`,
      ...shown.map((snapshot) => pastSeasonLine(state, snapshot)),
      ...(seasons.length > shown.length ? [`  …그 외 ${seasons.length - shown.length}시즌`] : []),
    ].join("\n"),
  };
}
