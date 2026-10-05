import { CLUB_TIER_KO, interviewFactText, ageOf } from "@gaffer/domain";
import { openManagerOffers } from "../../people/manager-employment";
import {
  pendingManagerInterviews,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../../core/state";
import { formatMoney } from "../../team/finance";
import { diffDays } from "../../core/dates";
import { careerTotalsOf } from "../../players/career";
import { competitionName } from "../../core/catalog/cup-catalog";
import { leagueOfTeamIn, tierOfTeamIn } from "../../core/league-membership";
import { achievementLine } from "../../people/achievements";
import { awardLine } from "../../season/awards";
import { computeStandings } from "../../season/standings";
import { managerTenureOf, managerTrophiesOf, seasonLabelOf } from "../../season/records";
import { LookupResult } from "./resolve";
import { seasonLabel } from "./league";

// ── 감독 커리어 (지난 시즌·트로피·업적·시상) ────────────

/** 커리어 카드에 세우는 시상 줄의 수 — 스무 시즌이면 상만 여든 줄이다 */
const AWARDS_SHOWN = 6;

/**
 * 감독 커리어 — 지난 시즌 성적·트로피·업적. 멀티시즌 게임인데 과거를 읽을 자리가
 * 없으면 "작년엔 어땠지"에 답할 수 없다 (경기 장부는 시즌마다 교체되므로
 * `SEASON_RECORD`가 과거의 유일한 원본이다).
 */
export function careerView(state: GameState): LookupResult {
  const league = leagueOfTeamIn(state, state.userTeamId);
  const table = computeStandings(state, league);
  const row = table.find((r) => r.teamId === state.userTeamId);
  const rank = table.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const m = state.manager;

  /**
   * **커리어가 끝났으면 머리글부터 다르다** (career.md §5.1) — 옛 구단의 순위·경고를
   * 재임 중인 것처럼 세우면 모델이 그 구단의 감독으로 장면을 쓴다.
   */
  const card = state.dismissal;
  const lines = card
    ? [
        `[커리어] ${m.name} — 커리어 종료 (${card.on} ${teamNameIn(state, card.teamId)}에서 ${
          card.kind === "expired" ? "계약 만료" : "경질"
        }) · ${seasonLabel(state.season)}`,
        `당시 구단 체급: ${CLUB_TIER_KO[card.tier]}` +
          (card.position === undefined ? "" : ` · 당시 ${card.position}위`),
        ...(card.severance ? [`위약금 ${formatMoney(card.severance)}`] : []),
        ...(openManagerOffers(state).length > 0
          ? [
              `받은 감독직 제안:`,
              ...openManagerOffers(state).map(
                (o) =>
                  `  ${o.id} · ${teamNameIn(state, o.teamId)} (${CLUB_TIER_KO[o.tier]})` +
                  (o.position ? ` · 현재 ${o.position}위` : "") +
                  ` · 연봉 ${formatMoney(o.salary)}·${o.years}년` +
                  ` · ${o.expiresOn}까지`,
              ),
            ]
          : [`받은 감독직 제안: 없음`]),
        ...(state.managerVacancies.length > 0
          ? [
              `최근 공석 (지원할 수 있는 자리):`,
              ...state.managerVacancies.map(
                (v) =>
                  `  ${teamNameIn(state, v.teamId)} (${CLUB_TIER_KO[tierOfTeamIn(state, v.teamId)]})` +
                  (v.position ? ` · 현재 ${v.position}위` : "") +
                  ` · ${v.on} 공석`,
              ),
            ]
          : []),
      ]
    : [
        `[커리어] ${m.name} — ${teamNameIn(state, state.userTeamId)} 재임 · ${seasonLabel(state.season)}`,
        ...(m.contract
          ? [
              `계약: 연봉 ${formatMoney(m.contract.salary)} · ${m.contract.until}까지` +
                ` (${diffDays(state.date, m.contract.until)}일)`,
            ]
          : []),
        ...openManagerOffers(state).map(
          (o) =>
            `${o.via === "renewal" ? "재계약" : "감독직"} 제안: ${o.id} · ${teamNameIn(state, o.teamId)} · 연봉 ${formatMoney(o.salary)}·${o.years}년` +
            ` · ${o.expiresOn}까지`,
        ),
        row && row.played > 0
          ? `이번 시즌 진행: ${competitionName(league)} ${rank}위 · ${row.played}경기 ${row.wins}승 ${row.draws}무 ${row.losses}패 · 승점 ${row.points} (득실 ${row.goalDiff >= 0 ? "+" : ""}${row.goalDiff})`
          : `이번 시즌 진행: 아직 리그 경기 없음`,
      ];

  if (!state.dismissal && state.managerVacancies.length) {
    lines.push(
      "공석:",
      ...state.managerVacancies.map(
        (vacancy) =>
          `  ${teamNameIn(state, vacancy.teamId)} (${vacancy.teamId}) · ${vacancy.on}부터`,
      ),
    );
  }
  const interviews = pendingManagerInterviews(state);
  if (interviews.length) {
    lines.push(
      "열린 감독직 면접:",
      ...interviews.map(
        (interview) =>
          `  ${interview.id} · ${teamNameIn(state, interview.teamId)} (${interview.teamId}) · ${interview.date} · ${interview.facts.map((fact) => interviewFactText(fact)).join(" · ")}`,
      ),
    );
  }
  if (state.managerPool.length) {
    lines.push(
      "무직 AI 감독:",
      ...state.managerPool.map(
        (candidate) =>
          `  ${candidate.name} · 전술 역량 ${candidate.rating} · 전 ${teamNameIn(state, candidate.lastTeamId)} · ${candidate.sackedOn}부터 무직 · 재임 ${candidate.spells.map((spell) => `${spell.teamId} ${spell.from}~${spell.to}`).join(", ")}`,
      ),
    );
  }

  /**
   * 시즌 기록과 경질 이력을 한 표로 잇는다 (career.md §6) — 잘린 시즌은
   * `SEASON_RECORD`가 없으므로 경질 줄이 그 해를 채운다. 최신 시즌이 앞이고,
   * 같은 시즌 안에서는 시즌 결산(시즌 끝)이 경질(시즌 중)보다 앞이다.
   */
  const sackings = state.dismissals;
  const rows = [
    ...state.seasonRecords.map((r) => ({
      season: r.season,
      atEnd: 1,
      on: "",
      text:
        `  시즌 ${r.season} (${seasonLabelOf(r.season)}) ${teamNameIn(state, r.teamId)} ` +
        `${r.position}위 · ${r.wins}승 ${r.draws}무 ${r.losses}패 · 득 ${r.goalsFor} 실 ${r.goalsAgainst}`,
    })),
    ...sackings.map((d) => ({
      season: d.season,
      atEnd: 0,
      on: d.on,
      text:
        `  시즌 ${d.season} (${seasonLabelOf(d.season)}) ${teamNameIn(state, d.teamId)} — ${d.on} ` +
        `${d.kind === "expired" ? "계약 만료" : "경질"}` +
        ` (${CLUB_TIER_KO[d.tier]}` +
        (d.position === undefined ? ")" : ` · 당시 ${d.position}위)`),
    })),
  ].sort((a, b) => b.season - a.season || b.atEnd - a.atEnd || b.on.localeCompare(a.on));
  if (rows.length === 0) {
    lines.push("지난 시즌 기록: 없음 (첫 시즌이다)");
  } else {
    lines.push(`지난 시즌 기록 ${state.seasonRecords.length}시즌:`);
    for (const r of rows.slice(0, 10)) lines.push(r.text);
    if (rows.length > 10) lines.push(`  …그 외 ${rows.length - 10}줄`);
  }

  /**
   * **보관함은 원장이 아니다** (career.md §6). `TROPHY`는 전 구단의 우승을 드는
   * 세계의 원장이라, 그대로 세우면 AI 구단이 든 컵이 감독의 보관함에 선다 —
   * 재임 여부는 `managerTrophiesOf`가 `SEASON_RECORD`의 (시즌, 팀)으로 가른다.
   */
  const trophies = managerTrophiesOf(state);
  lines.push(
    trophies.length > 0
      ? // TROPHY는 대회 id로 남는다 — 이름은 여기서 카탈로그가 만든다 (career.md §6)
        `트로피 ${trophies.length}개: ${trophies
          .map(
            (t) =>
              `${competitionName(t.competitionId)} ` +
              `(시즌 ${t.season}, ${teamShortNameIn(state, t.teamId)})`,
          )
          .join(" / ")}`
      : "트로피: 없음",
  );
  /**
   * **시상은 선수의 것이지만 어느 해에 우리 선수가 상을 들었는가는 감독의 이력이다**
   * (career.md §6). 그래서 세우는 것은 감독이 그 시즌 맡고 있던 팀의 상뿐이고, 남의
   * 리그 득점왕은 여기 서지 않는다 — 트로피와 같은 자로 가른다. 대회는 리그만이
   * 아니다: 컵·대항전의 득점왕과 결승 MOM도 같은 자로 걸린다 (season.md §6).
   */
  // 감독이 그 시즌 그 팀에 있었나 — 트로피 보관함과 **같은 자**로 잰다 (career.md §6)
  const managedThen = managerTenureOf(state);
  const awards = state.awards
    .filter((a) => managedThen(a.season, a.teamId))
    .sort((a, b) => b.season - a.season || a.code.localeCompare(b.code));
  if (awards.length > 0) {
    const shown = awards.slice(0, AWARDS_SHOWN);
    lines.push(
      `우리 선수의 시상 ${awards.length}건:`,
      ...shown.map((a) => `  시즌 ${a.season} ${awardLine(a)}`),
    );
    if (awards.length > shown.length) lines.push(`  …그 외 ${awards.length - shown.length}건`);
  }
  if (state.achievements.length > 0) {
    lines.push(
      `업적 ${state.achievements.length}개: ${state.achievements
        .map((a) => `${achievementLine(a)} (시즌 ${a.season})`)
        .join(" / ")}`,
    );
  }
  /**
   * **은퇴 명부** — 감독이 데리고 있다 보낸 사람들 (season.md §6). 명단에서 사라진
   * 이름을 되찾을 수 있는 유일한 자리라 통산과 함께 선다 — 통산은 명부가 아니라
   * `seasonStats`에서 온다(`careerTotalsOf`), 한 값을 두 곳에 적지 않는다.
   */
  const retired = [...state.retired].sort((a, b) => b.season - a.season);
  if (retired.length > 0) {
    lines.push(`은퇴 ${retired.length}명 (우리 팀에서):`);
    for (const r of retired.slice(0, RETIRED_SHOWN)) {
      const totals = careerTotalsOf(state, r.gamePlayerId, r.teamId);
      lines.push(
        `  시즌 ${r.season} ${r.name} (${r.position}) — 만 ${ageOf(r.birthdate, r.on)}세 · ` +
          `${teamShortNameIn(state, r.teamId)}에서 ${totals.apps}경기 ${totals.goals}골 ${totals.assists}도움`,
      );
    }
    if (retired.length > RETIRED_SHOWN) {
      lines.push(`  …그 외 ${retired.length - RETIRED_SHOWN}명`);
    }
  }
  return { ok: true, message: lines.join("\n") };
}

/** 커리어 카드에 세우는 은퇴 이름의 수 — 스무 시즌이면 명부가 카드를 통째로 덮는다 */
const RETIRED_SHOWN = 8;
