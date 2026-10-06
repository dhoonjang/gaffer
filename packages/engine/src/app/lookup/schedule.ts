import { type ScheduleEntry, slotOfTime } from "@gaffer/domain";
import { outcomeFor, outcomeLabel } from "../views/attention";
import { pushRecordJournal, type CalendarEventView } from "../views/calendar";
import { squadReturnOf } from "../../core/calendar";
import { addDays } from "../../core/dates";
import { drawParts, drawTitle } from "../../season/draw-schedule";
import { teamNameIn, type GameState } from "../../core/state";
import { type LookupResult } from "./resolve";
import { dateLabel, competitionTag } from "./league";

// ── 감독의 달력 (경기 + 훈련) ────────────────────────

interface ScheduleViewInput {
  /** 시작일 — 기본 오늘 */
  from?: string;
  /** 종료일 — 없으면 from + days */
  to?: string;
  /** to가 없을 때의 창 길이 (기본 14일) */
  days?: number;
  /** 종류로 좁히기 */
  type?: "match" | "training";
  /** 최대 엔트리 수 (기본 25) */
  limit?: number;
}

const SCHEDULE_LIMIT = 25;

/**
 * 일지 줄의 이름 — 화면은 도형으로 갈라 읽지만(`views.ts` `CalendarEventView`) 조회는
 * 글자로 가른다. 갈래를 데이터로 주는 규약은 그대로다: 이름을 붙이는 자리가 여기 하나다.
 */
const JOURNAL_KIND_KO: Record<CalendarEventView["kind"], string> = {
  match: "경기",
  training: "훈련",
  rest: "휴식",
  growth: "성장",
  injury: "부상",
  return: "복귀",
  yellow: "경고",
  red: "퇴장",
  move: "들고 남",
  money: "돈",
};

/**
 * 한 번의 조회가 낼 일지 줄의 상한.
 *
 * 일정의 `limit`과 **묶지 않는다** — 석 달치 일정을 부르는 것과 석 달치 일지를 통째로
 * 모델 컨텍스트에 붓는 것은 다른 값이다. 넘치면 뒤를 자르고 몇 건이 남았는지 말한다.
 * 2주치 일지가 대개 이 아래라 "지난주에 무슨 일 있었나"는 잘리지 않는다.
 */
const JOURNAL_LIMIT = 40;

/**
 * 지나간 날의 일지 — 화면의 달력이 세우는 것과 **같은 표**다(`pushRecordJournal`).
 *
 * 일정 축(경기·훈련)은 위의 일정 줄이 이미 세우므로 여기 다시 서지 않는다.
 * 남는 것은 기록 테이블과 서사 표 몫 — 성장·부상·카드·이동·돈·소식이고, 손잡이로
 * 며칠을 넘긴 턴에 다이제스트로만 흘러간 사건이 여기 있다 (people.md §9).
 */
function pastJournalLines(state: GameState, from: string, to: string): string[] {
  if (from >= state.date) return [];
  const journal: Record<string, CalendarEventView[]> = {};
  pushRecordJournal(state, journal);
  const last = to < state.date ? to : state.date;
  const dates = Object.keys(journal)
    .filter((d) => d >= from && d <= last)
    .sort();

  const out: string[] = [];
  let shown = 0;
  let dropped = 0;
  for (const date of dates) {
    const events = journal[date] ?? [];
    const room = JOURNAL_LIMIT - shown;
    if (room <= 0) {
      dropped += events.length;
      continue;
    }
    out.push(`  ${dateLabel(date)}`);
    for (const e of events.slice(0, room)) {
      out.push(`    ${JOURNAL_KIND_KO[e.kind]} ${e.text}`);
    }
    shown += Math.min(events.length, room);
    dropped += Math.max(0, events.length - room);
  }
  if (out.length === 0) return [];
  if (dropped > 0) out.push(`  …그 외 ${dropped}건 — 범위를 좁혀라`);
  return [`[일지] ${dateLabel(from)} ~ ${dateLabel(last)} — 그 사이 벌어진 일`, ...out];
}

/**
 * 감독의 달력 — 경기만 보는 `get_league`와 달리 **훈련·이적창까지** 한 축에 놓는다.
 * 일정 축이 `SCHEDULE_ENTRY` 하나로 정규화돼 있으니 조회도 한 곳에서 한다.
 *
 * 우리 팀 일정만 담는다 — 같은 리그 타 팀 경기도 엔트리로는 존재하지만(순위표
 * 계산용) 그건 감독의 달력이 아니다. 리그 전체 편성은 `get_league`가 답한다.
 */
export function scheduleView(state: GameState, input: ScheduleViewInput = {}): LookupResult {
  const from = input.from ?? state.date;
  const days = Math.min(Math.max(input.days ?? 14, 1), 365);
  const to = input.to ?? addDays(from, days);
  if (to < from) return { ok: false, message: `날짜 범위가 뒤집혀 있습니다 (${from} ~ ${to})` };

  const matchById = new Map(state.matches.map((m) => [m.id, m]));
  const sessionById = new Map(state.trainingSessions.map((s) => [s.id, s]));
  const wanted = (e: ScheduleEntry) => !input.type || e.type === input.type;

  const entries = state.schedule
    .filter((e) => e.date >= from && e.date <= to && wanted(e))
    .filter((e) => {
      // 경기는 우리 팀 경기만 (teamId=null은 리그 타 팀 경기 — 달력에 올리지 않는다)
      if (e.type === "match") return e.teamId !== null;
      return true;
    })
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1));

  const limit = Math.min(Math.max(input.limit ?? SCHEDULE_LIMIT, 1), 60);
  const shown = entries.slice(0, limit);
  const lines = [
    `[달력] ${dateLabel(from)} ~ ${dateLabel(to)} — ${teamNameIn(state, state.userTeamId)} · 오늘 ${dateLabel(state.date)}`,
  ];
  /**
   * 여름 휴가는 **일정이 없는 기간**이라 엔트리로는 보이지 않는다. 그런데 "훈련을
   * 언제부터 잡을 수 있나"는 감독이 달력에서 가장 먼저 묻는 것이라, 비어 있는
   * 이유를 여기서 한 줄로 말한다 (`setTraining`이 거부하기 전에 알 수 있게).
   */
  const squadReturn = squadReturnOf(state.calendar);
  if (from < squadReturn) {
    lines.push(
      `  ${dateLabel(from)} ~ ${dateLabel(addDays(squadReturn, -1))} 선수단 여름 휴가 — 훈련 없음 (소집 ${dateLabel(squadReturn)})`,
    );
  }
  /**
   * 지나간 날은 일정만으로 답이 되지 않는다 — 보드 답이 언제 왔고 계약 경고가 언제
   * 섰는지는 일정 축이 아니라 일지에 있다. 앞날만 묻는 창(`from`이 오늘 이후)에는
   * 일지가 없으므로 한 줄도 붙지 않는다.
   */
  const journal = pastJournalLines(state, from, to);
  if (shown.length === 0) {
    lines.push("이 기간에 등록된 일정이 없습니다");
    lines.push(...journal);
    return { ok: true, message: lines.join("\n") };
  }

  for (const e of shown) {
    const when = `  ${dateLabel(e.date)} ${e.time}`;
    if (e.type === "match") {
      const m = matchById.get(e.refId);
      if (!m) continue;
      const home = m.homeTeamId === state.userTeamId;
      const versus = teamNameIn(state, home ? m.awayTeamId : m.homeTeamId);
      const side = m.neutral ? "중립" : home ? "홈" : "원정";
      const score = m.result
        ? ` — ${m.result.homeGoals}-${m.result.awayGoals} ${outcomeLabel(outcomeFor(m, state.userTeamId))}`
        : "";
      lines.push(`${when} 경기 ${competitionTag(m)} ${side} vs ${versus}${score}`);
      continue;
    }
    if (e.type === "training") {
      const s = sessionById.get(e.refId);
      const slot = slotOfTime(e.time) === "am" ? "오전" : "오후";
      lines.push(
        `${when} 훈련 (${slot}) ${s?.label ?? "훈련"}` +
          (s && s.focus.length > 0 ? ` · 효과 ${s.focus.join("·")}` : "") +
          (e.status === "done" ? " [완료]" : ""),
      );
      continue;
    }
    if (e.type === "draw") {
      lines.push(`${when} ${drawTitle(e.refId)}${e.status === "done" ? " [완료]" : ""}`);
      continue;
    }
    // 상대는 추첨에서 정해진다 — 날짜만 공표된 자리다
    const { competition, stage } = drawParts(e.refId);
    lines.push(`${when} ${competition} ${stage} 예정 (상대 미정)`);
  }
  if (entries.length > shown.length) {
    lines.push(`  …그 외 ${entries.length - shown.length}건 — 범위를 좁히거나 limit을 올려라`);
  }
  lines.push(...journal);
  return { ok: true, message: lines.join("\n") };
}
