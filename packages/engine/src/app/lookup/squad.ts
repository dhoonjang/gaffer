import {
  playerOverall,
  type GamePlayer,
  type GameTeam,
  type Persona,
  type YouthCandidate,
  injuryHistoryText,
  yellowBanMatches,
  personaRoleLabel,
  ageOf,
  anchorOf,
  familiarityLabel,
  naturalPositionOf,
  roleFit,
} from "@gaffer/domain";
import { describeStaffPool } from "../../people/staff-employment";
import { personaBookOf } from "../../people/lorebook";
import { formatMoney } from "../../team/finance";
import { youthCandidateFog } from "../../players/observation";
import { diffDays } from "../../core/dates";
import { disciplineOf, suspensionScopeName } from "../../core/catalog/discipline-catalog";
import { formLabel } from "../../players/form";
import { injuryHistoryOf } from "../../players/injury";
import { registrationLine, squadRegistrationOf } from "../../team/registration";
import { competitionShortName } from "../../core/catalog/cup-catalog";
import { ourYouthCandidates, youthIntakeDeadline } from "../../players/youth";
import {
  activeContract,
  activeSuspension,
  seasonYellowsOf,
  assignmentFor,
  familiarityOf,
  openInjury,
  playersOf,
  proficiencyAt,
  seasonStatOf,
  squadFamiliarity,
  squadLevelOf,
  tacticsOf,
  teamNameIn,
  type GameState,
} from "../../core/state";
import { headCoachOf, staffOf } from "../../people/persona";
import {
  type LookupResult,
  armband,
  type DisciplineFixture,
  disciplineFixtureOf,
  statLine,
  contractLabel,
} from "./resolve";
import { roleLabel } from "./player-card";

// ── 스쿼드·배치 (우리 팀 전용) ──────────────────────────

interface SquadViewInput {
  /**
   * 1군 / 2군 / 전체 — 기본 1군 (2군 18명까지 매번 읽을 이유가 없다).
   */
  level?: "first" | "reserve" | "all" | undefined;
  /** 배치 역할로 좁히기 — starting(선발 11) / bench / unassigned(예비) */
  role?: "starting" | "bench" | "unassigned" | undefined;
}

/**
 * 배치 순서는 **전술판 좌표**에서 나온다 — 골문 쪽 라인부터, 라인 안에서는 왼쪽부터
 * (포지션 코드를 알파벳순으로 세우면 LB·LCB·RB·RCB로 뒤엉켜 라인업으로 읽히지 않는다).
 * y를 12 단위로 뭉쳐 같은 라인으로 묶고 그 안에서 x로 세운다.
 */
function boardOrder(state: GameState, playerId: string, position: string): [number, number] {
  const point = assignmentFor(state, playerId)?.point ?? anchorOf(position);
  return [-Math.round(point.y / 12), point.x];
}

/**
 * 배치 한 줄 — 그 **자리에서의** 적합도와 포지션 적응도를 함께 준다.
 * 자리를 바꿀지 판단하려면 "라이스가 좋은 선수인가"가 아니라 "이 자리에서
 * 좋은가"를 알아야 한다 (roleFit은 자리마다 다른 값을 낸다).
 */
function assignedRow(
  state: GameState,
  p: GamePlayer,
  position: string,
  familiarity: number,
  next: DisciplineFixture | null,
  roleId?: string,
): string {
  /**
   * **다음 대회 경기로 잰다** (match.md §6) — 눈금도 정지도 대회의 것이라,
   * 대회 없이 센 경고 수는 이 라인업 화면에서 잘못된 경고를 띄운다.
   */
  const yellows =
    next === null ? 0 : seasonYellowsOf(state, p.id, state.season, next.competitionId);
  const rule = next === null ? null : disciplineOf(next.competitionId);
  const banNext =
    next !== null && rule !== null && yellowBanMatches(rule, yellows + 1, next) !== null;
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const contract = activeContract(state, p.id);
  const flags = [
    injury ? `부상(${injury.bodyPart}, ~${injury.expectedReturn})` : null,
    suspension
      ? `정지 ${suspension.lengthMatches - suspension.served}경기(${suspensionScopeName(suspension)})`
      : null,
    banNext ? `${competitionShortName(next.competitionId)} 경고 ${yellows}장(정지 임박)` : null,
    /**
     * **다치기 전에 서는 유일한 줄이다** (player.md §5.3) — 부상 플래그는 이미
     * 쓰러진 뒤의 사실이라, 이 줄이 없으면 라인업을 세우는 자리에서 감독이 몸의
     * 내력을 읽을 자리가 없다. **등급을 세우지 않는다** — 이력이 없는 선수는 아무
     * 줄도 달지 않으므로, 내력이 있는 사람만 도드라진다 (player.md §5.3).
     */
    injuryHistoryText(injuryHistoryOf(state, p.id)),
  ].filter((x): x is string => x !== null);
  return (
    `  ${position.padEnd(4)} ${p.name}${armband(p)} (${p.id}) ${ageOf(p.birthdate, state.date)}세 · ` +
    `${roleLabel(position, roleId)} · OVR${playerOverall(p)} 자리적합${roleFit(p.attributes, position, roleId)} 포지션적응${proficiencyAt(p, position)} ` +
    `전술적응${familiarity} · 폼 ${formLabel(p.state.form)} 체력${p.state.condition}` +
    // **라인업을 세우는 자리가 계약 만료를 읽는 자리이기도 하다** —
    // 만료일이 없으면 감독은 여름에 사라질 주전을 붙박이로 세운다
    (contract ? ` · 계약${contractLabel(contract)}` : "") +
    ` · ${statLine(stat)}` +
    (flags.length > 0 ? ` · ⚠${flags.join(" · ")}` : "")
  );
}

/**
 * 우리 스쿼드와 **현재 배치** — 라인업을 바꾸기 전에 지금 누가 어디에 서 있는지.
 *
 * 왜 별도 도구인가: 컨텍스트엔 선수단 이름뿐이라 배치가 없고 `search_players`는 상한이
 * 15명이라 43명 스쿼드의 선발 11·벤치 9를 한눈에 볼 방법이 없었다. 모르는 것을
 * 지어내지 않게 하려면 "현재 라인업"을 정확히 읽을 자리가 필요하다.
 *
 * 타 팀 스쿼드는 여기서 볼 수 없다 — 상대 라인업을 미리 아는 것은 안개 위반이다
 * (상대 전력은 `get_team`의 팀 프로필로).
 */
export function squadView(state: GameState, input: SquadViewInput = {}): LookupResult {
  const teamId = state.userTeamId;
  const tactics = tacticsOf(state, teamId);
  const squad = playersOf(state, teamId);
  const level = input.level ?? "first";
  const assignments = new Map(tactics.assignments.map((a) => [a.playerId, a]));

  const inLevel = squad.filter((p) =>
    level === "all" ? true : squadLevelOf(p) === (level === "reserve" ? "reserve" : "first"),
  );
  const bucketOf = (p: GamePlayer): "starting" | "bench" | "unassigned" =>
    assignments.get(p.id)?.role ?? "unassigned";
  const sortRow = (a: GamePlayer, b: GamePlayer) => {
    const [lineA, xA] = boardOrder(
      state,
      a.id,
      assignments.get(a.id)?.position ?? naturalPositionOf(a).position,
    );
    const [lineB, xB] = boardOrder(
      state,
      b.id,
      assignments.get(b.id)?.position ?? naturalPositionOf(b).position,
    );
    return lineA !== lineB ? lineA - lineB : xA - xB;
  };
  // 경고 임박은 **다음 대회 경기**로 잰다 — 한 번 찾아 모든 줄이 나눠 쓴다
  const nextFixture = disciplineFixtureOf(state, teamId);
  const rowsFor = (bucket: "starting" | "bench" | "unassigned") =>
    inLevel
      .filter((p) => bucketOf(p) === bucket)
      .sort(sortRow)
      .map((p) => {
        const a = assignments.get(p.id);
        return assignedRow(
          state,
          p,
          a?.position ?? naturalPositionOf(p).position,
          a?.familiarity ?? familiarityOf(state, p.id),
          nextFixture,
          a?.roleId,
        );
      });

  const spec = tactics.spec;
  const firstCount = squad.filter((p) => squadLevelOf(p) !== "reserve").length;
  const lines = [
    `[스쿼드] ${teamNameIn(state, teamId)} — ${spec.formation} · 멘탈${spec.mentality} 라인${spec.defensiveLine} ` +
      `압박${spec.pressing} 템포${spec.tempo} 폭${spec.width} 패스${spec.passStyle} · ` +
      `선발 평균 적응 ${familiarityLabel(squadFamiliarity(state, teamId))}`,
    `1군 ${firstCount}명 (선발 ${tactics.assignments.filter((a) => a.role === "starting").length} · ` +
      `벤치 ${tactics.assignments.filter((a) => a.role === "bench").length}) · ` +
      `2군 ${squad.length - firstCount}명 · 조회 대상: ${
        level === "all" ? "전체" : level === "reserve" ? "2군" : "1군"
      }`,
    // 등록 명단 — 승격 판단의 전제라 스쿼드를 볼 때 항상 함께 읽힌다
    registrationLine(squadRegistrationOf(state, teamId)),
    `완장: ${
      squad
        .filter((p) => p.isCaptain || p.isViceCaptain)
        .map((p) => `${p.name}(${p.isCaptain ? "주장" : "부주장"})`)
        .join(" · ") || "없음"
    }`,
  ];

  const buckets: ReadonlyArray<["starting" | "bench" | "unassigned", string]> = [
    ["starting", "선발"],
    ["bench", "벤치"],
    ["unassigned", "예비 (배치 없음 — 라인업에 넣으려면 set_lineup)"],
  ];
  let shown = 0;
  for (const [bucket, label] of buckets) {
    if (input.role && input.role !== bucket) continue;
    const rows = rowsFor(bucket);
    if (rows.length === 0) continue;
    shown += rows.length;
    lines.push(`── ${label} ${rows.length}명 ──`, ...rows);
  }
  if (shown === 0) {
    lines.push("조건에 맞는 선수가 없습니다 (level·role을 확인하라)");
  }
  /**
   * **유스 후보도 자기 구획이다** — 아직 계약하지 않아 층도 배치도 없는 사람들이라
   * 명단에 섞으면 부릴 수 있는 인원으로 읽힌다 (season.md §6). 소집일이 지나면
   * 후보 줄 자체가 사라지므로 이 구획도 여름에만 선다.
   */
  const candidates = teamId === state.userTeamId ? ourYouthCandidates(state) : [];
  if (candidates.length > 0 && !input.role) {
    lines.push(
      `── 유스 후보 ${candidates.length}명 (${youthIntakeDeadline(state)}까지 sign_youth) ──`,
      ...candidates.map((row) => youthCandidateRow(state, row)),
    );
  }
  /**
   * **스태프 구획** — 훈련장·의무실·보고서를 맡은 사람들 (people.md §2-2). 명단에
   * 섞지 않는 이유는 유스 후보와 같다: 판에 올릴 수 있는 인원이 아니다.
   *
   * ⚠️ **좁힌 조회에는 서지 않는다** — 층(`level`)도 역할(`role`)도 스쿼드의 칸이고
   * 스태프는 그 칸에 없다.
   */
  if (teamId === state.userTeamId && input.role === undefined && input.level === undefined) {
    // 수석코치는 자리가 비지 않는다 (`headCoachOf`) — 이 절은 언제나 한 줄 이상이다
    const ours = [headCoachOf(state), ...staffOf(state)];
    lines.push(`── 스태프 ${ours.length}명 ──`, ...ours.map((persona) => staffRow(state, persona)));
    const pool = describeStaffPool(state);
    if (pool.length > 0) {
      // 유스 절이 `sign_youth`를 대는 것과 같은 규약 — 이 목록으로 무엇을 할 수 있는가
      lines.push(`── 자리를 찾는 스태프 ${pool.length}명 (hire_staff) ──`, ...pool);
    }
  }
  return { ok: true, message: lines.join("\n") };
}

/**
 * 스태프 한 줄 — 이름 · 직책 · 현재 설명 · 부임일 · 계약 만료일.
 *
 * 직책이 역할 라벨보다 앞서는 것은 화자 칩과 같은 규약이다 (people.md §3): 「코치」는
 * 이미 알고 있고, 감독이 알아야 할 것은 훈련장의 어느 자리냐다. 고용 정보가 없는 옛
 * 세이브는 역할 라벨로 서고 날짜 칸이 빠진다 — 없는 계약을 지어내지 않는다.
 */
function staffRow(state: GameState, persona: Persona): string {
  const employment = persona.employment;
  const facts = [
    employment?.title ?? personaRoleLabel(persona.role) ?? persona.role,
    personaBookOf(state, persona).description,
    employment === undefined ? null : `부임 ${employment.since}`,
    employment === undefined
      ? null
      : `계약 ~${employment.contract.until} · 연봉 ${formatMoney(employment.contract.salary)}`,
  ].filter((x): x is string => x !== null);
  // ⚠️ 두 칸 들여쓰기는 **배치 줄의 것이다** — 유스 후보 줄과 같이 스태프도 들여쓰지
  // 않는다. 층·역할의 칸에 서지 않는 사람은 명단의 자를 빌리지 않는다
  return `${persona.name} · ${facts.join(" · ")}`;
}

/**
 * 유스 후보 한 줄 — **안개가 낀 사실이다** (season.md §6 · player.md §9). 아직 우리
 * 선수가 아니라 종합도 성장 가능성도 참값이 아니고, GM 스냅샷의 오프시즌 블록·스쿼드 화면과
 * 같은 함수(`youthCandidateFog`)를 읽어 같은 숫자를 낸다.
 */
function youthCandidateRow(state: GameState, row: YouthCandidate): string {
  const { overall, growth } = youthCandidateFog(state.seed, row.player);
  const age = ageOf(row.player.birthdate, state.date);
  return (
    `${row.player.name} (${naturalPositionOf(row.player).position}) ${age}세 · ` +
    `종합 ~${overall} · 성장 가능성 ${growth.label} · ` +
    `주급 ${formatMoney(row.weeklyWage)}/주 ${row.years}년` +
    (row.autoSign ? " · 답이 없으면 구단이 계약" : "")
  );
}

/**
 * **벤치에 선 사람 한 줄** — 이름 · 재임 일수. 오늘 앉은 사람은 일수를 적지 않는다:
 * 0인 칸은 적지 않는다.
 */
export function managerLine(state: GameState, bench: GameTeam): string {
  const since = bench.managerSince;
  const days = since === undefined ? 0 : diffDays(since, state.date);
  return `감독: ${bench.managerName}` + (days <= 0 ? "" : ` — 부임 ${days}일째`);
}
