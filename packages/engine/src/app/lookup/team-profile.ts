import { type GamePlayer, isReserveMatch, ageOf } from "@story-fm/domain";
import { derbyRecordOf } from "../../core/derby";
import { derbyOf } from "../../core/catalog/derbies";
import { outcomeFor, outcomeLabel } from "../views/attention";
import { DERBY_HEAT_KO } from "../../match/preview";
import { competitionName } from "../../core/catalog/cup-catalog";
import { isClubTeam } from "../../core/catalog/team-catalog";
import { leagueOfTeamIn, tierOfTeamIn } from "../../core/league-membership";
import { computeStandings } from "../../season/standings";
import { clubHonoursLine } from "../../season/records";
import {
  playerById,
  playersOf,
  tacticsOf,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../../core/state";
import { dateLabel, competitionTag } from "./league";
import { LookupResult, resolveTeam, ourRow, theirRow, sortRating } from "./resolve";
import { managerLine } from "./squad";

// ── 팀 프로필 (상대 전력) ───────────────────────────

export function teamProfile(state: GameState, team: string): LookupResult {
  const resolved = resolveTeam(state, team);
  if (!resolved.ok) return resolved;
  const teamId = resolved.teamId;
  // 무소속은 클럽이 아니다 — 순위도 배치도 없어 프로필이 성립하지 않는다 (team.md §4)
  if (!isClubTeam(teamId)) {
    return {
      ok: false,
      message: "무소속은 구단이 아닙니다 — 자유계약 선수는 선수 검색으로 봅니다",
    };
  }

  // 순위는 **그 팀의 리그** 기준 — 타 리그 팀에 우리 리그 표를 대면 순위가 없다
  const standings = computeStandings(state, leagueOfTeamIn(state, teamId));
  const row = standings.find((r) => r.teamId === teamId);
  const rank = standings.findIndex((r) => r.teamId === teamId) + 1;
  const squad = playersOf(state, teamId);
  const tactics = tacticsOf(state, teamId);
  const avgAge =
    squad.length > 0
      ? squad.reduce((s, p) => s + ageOf(p.birthdate, state.date), 0) / squad.length
      : 0;

  // 날짜순 정렬 — state.matches는 리그 뒤에 대항전이 붙은 순서라 그대로 자르면 섞인다.
  // 2군 경기는 팀 프로필의 최근 결과·전적·다음 맞대결 어디에도 서지 않는다
  const byDate = [...state.matches]
    .filter((m) => !isReserveMatch(m))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = byDate
    .filter((m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId))
    .slice(-5)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const my = home ? m.result!.homeGoals : m.result!.awayGoals;
      const their = home ? m.result!.awayGoals : m.result!.homeGoals;
      return (
        `${competitionTag(m)} ${my}-${their} vs ${teamShortNameIn(state, home ? m.awayTeamId : m.homeTeamId)} ` +
        outcomeLabel(outcomeFor(m, teamId))
      );
    });

  // 우리와의 상대 전적
  const h2h = byDate.filter(
    (m) =>
      m.result &&
      ((m.homeTeamId === teamId && m.awayTeamId === state.userTeamId) ||
        (m.awayTeamId === teamId && m.homeTeamId === state.userTeamId)),
  );
  const nextH2h = byDate.find(
    (m) =>
      !m.result &&
      m.date >= state.date &&
      ((m.homeTeamId === teamId && m.awayTeamId === state.userTeamId) ||
        (m.awayTeamId === teamId && m.homeTeamId === state.userTeamId)),
  );
  let w = 0;
  let d = 0;
  let l = 0;
  for (const m of h2h) {
    const outcome = outcomeFor(m, state.userTeamId);
    if (outcome === "W") w++;
    else if (outcome === "L") l++;
    else d++;
  }

  const keyPlayers = tactics.assignments
    .filter((a) => a.role === "starting")
    .map((a) => playerById(state, a.playerId))
    .filter((p): p is GamePlayer => p !== null)
    .sort((a, b) => sortRating(state, b) - sortRating(state, a))
    .slice(0, 6);

  const bench = state.teams.find((t) => t.id === teamId);
  const honours = clubHonoursLine(state, teamId);

  const lines = [
    `[팀 프로필] ${teamNameIn(state, teamId)} — ${competitionName(leagueOfTeamIn(state, teamId))} ` +
      (row && row.played > 0
        ? `${rank || "?"}위 (${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} · 득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
        : "순위 미정 (아직 경기 없음)"),
    `전술: ${tactics.spec.formation} · 멘탈리티${tactics.spec.mentality} 압박${tactics.spec.pressing} 템포${tactics.spec.tempo} 패스${tactics.spec.passStyle}`,
    // 상대 벤치에 서는 사람 — 이름이 여기 나와야 인물 사전이 그 인물지를 세운다
    // (people.md §2-1). 이름을 모르는 구단은 줄이 서지 않는다
    ...(bench?.managerName === undefined ? [] : [managerLine(state, bench)]),
    `스쿼드: ${squad.length}명 · 평균 ${avgAge.toFixed(1)}세 · 구단 등급 ${tierOfTeamIn(state, teamId)}`,
    /**
     * **역대 한 줄** (team.md §1) — 카탈로그 시드와 게임 안의 우승을 더한 것이다.
     * 시드가 없고 게임 안의 우승도 없으면 줄이 서지 않는다: 없는 것은 0회가 아니라
     * 모르는 것이라 `null`이 온다.
     */
    ...(honours === null ? [] : [`역대: ${honours}`]),
    recent.length > 0 ? `최근 5경기: ${recent.join(" / ")}` : "최근 경기 없음",
  ];
  if (teamId !== state.userTeamId) {
    /**
     * **더비면 그 사실이 전적보다 먼저 선다** (team.md §3.2). 바로 아래의 맞대결
     * 전적과 수가 다른 것은 이쪽이 친선·2군을 세지 않기 때문이다 — 더비는 대회
     * 경기의 것이다.
     */
    const derby = derbyOf(state.userTeamId, teamId);
    if (derby) {
      const record = derbyRecordOf(state, teamId);
      lines.push(
        `더비: ${derby.name} — ${DERBY_HEAT_KO[derby.heat] ?? ""} · ` +
          `더비 전적 ${record.won}승 ${record.drawn}무 ${record.lost}패`,
      );
    }
    lines.push(
      `우리와의 전적 (이번 시즌): ${w}승 ${d}무 ${l}패` +
        (h2h.length > 0
          ? ` — ${h2h
              .slice(-3)
              .map((m) => `${competitionTag(m)} ${m.result!.homeGoals}-${m.result!.awayGoals}`)
              .join(" / ")}`
          : ""),
    );
    lines.push(
      nextH2h
        ? `다음 맞대결: ${competitionTag(nextH2h)} ${dateLabel(nextH2h.date)}${nextH2h.time ? ` ${nextH2h.time}` : ""} ` +
            `${nextH2h.neutral ? "중립" : nextH2h.homeTeamId === state.userTeamId ? "홈" : "원정"}`
        : "다음 맞대결: 남은 일정에 없음",
    );
    lines.push(`주력 선수 (안개 적용):`, ...keyPlayers.map((p) => `  ${theirRow(state, p)}`));
  } else {
    lines.push(`주력 선수:`, ...keyPlayers.map((p) => `  ${ourRow(state, p)}`));
  }
  return { ok: true, message: lines.join("\n") };
}
