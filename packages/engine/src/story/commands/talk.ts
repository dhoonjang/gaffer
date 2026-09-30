import {
  type GameState,
  userPlayers,
  pushNarrative,
  type CommandBriefItem,
} from "../../common/core/state";
import { type MoodNoteSubmission, applyMoodNotes } from "../../common/players/mood-notes";
import { pickOurPlayer } from "../../common/core/player-ref";
import { type PromiseOpened } from "../../common/players/promises";
import {
  PROMISE_KIND_KO,
  type IncidentKind,
  type ReactionInput,
  ReactionSchema,
  type GamePlayer,
  INCIDENT_KIND_KO,
  type TeamTalkOccasion,
  type PromiseKind,
  type PlayerIssueReason,
} from "@story-fm/domain";
import { item, signed, briefNames, deltaItems } from "../../common/commands/brief";
import { type CommandResult } from "../../common/commands/result";
import { applySocialReaction } from "../world/social";
import { applyCharacterMemories } from "../../common/people/persona";
import { resolveOpening } from "../people/openings";
import { addDays } from "../../common/core/dates";

/**
 * 감독이 부른 이름들을 id로 편다 — 심경 문장의 `playerId`가 이름일 수 있어서다
 * (agents.md §7). 풀리지 않는 이름의 줄은 버린다: `applyMoodNotes`가 닿지 않은
 * 선수를 버리는 것과 같은 결이다.
 */
export function resolveMoods(
  state: GameState,
  moods: readonly MoodNoteSubmission[],
): MoodNoteSubmission[] {
  const out: MoodNoteSubmission[] = [];
  for (const mood of moods) {
    const pick = pickOurPlayer(state, mood.playerId);
    if (pick.ok) out.push({ ...mood, playerId: pick.player.id });
  }
  return out;
}

/**
 * 대화·응대가 연 약속을 **한 조각으로** 옮긴다 (people.md §5-2).
 *
 * ⚠️ **반려도 조각이 된다.** 감독은 자기가 한 말이 장부에 섰는지를 알아야 하고,
 * 반려는 그 대화를 무르지 않는다 — 사기·압력은 이미 셈이 끝난 뒤다.
 * 두 자리가 같은 함수를 부르는 것은 같은 말이 자리마다 다른 줄로 서지 않게 하기
 * 위해서다.
 */
export function promisePiece(opened: PromiseOpened): PromisePiece {
  const promise = opened.promise;
  if (opened.ok && promise) {
    // `number` 약속만 숫자를 든다 — 갈래 이름만 세우면 어느 번호였는지가 사라진다
    const label =
      PROMISE_KIND_KO[promise.kind] + (promise.number === undefined ? "" : ` ${promise.number}번`);
    return {
      text: ` · ${label} 약속 (${promise.dueOn}까지)`,
      item: item({ label: "약속", text: label, note: `${promise.dueOn}까지` }),
    };
  }
  const why = opened.message ?? "약속을 세울 수 없습니다";
  return { text: ` · 약속 반려 — ${why}`, item: item({ label: "약속", text: "반려", note: why }) };
}

/** 그 방에 선 완장 — 주장이 없는 자리에서는 부주장이 그 이름이다 */
export function captainVoiceName(
  state: GameState,
  present: ReadonlySet<string> | undefined,
): string | undefined {
  const wearing = userPlayers(state).filter((p) => present === undefined || present.has(p.id));
  return (wearing.find((p) => p.isCaptain) ?? wearing.find((p) => p.isViceCaptain === true))?.name;
}

/**
 * `record_incident` — 벌금·포상·병문안·공개 칭찬과 질책·사과·중재·규칙·회식.
 * 코어가 만들지도 읽지도 못하는 사건을 GM이 그 턴에 세운다. 코어는 갈래·당사자·
 * 세기만 들고, 무슨 일이었는지는 `summary`와 장면의 것이다.
 *
 * 검증이 전부 앞에 선다 — 없는 이름이 하나라도 있으면 아무것도 움직이지 않는다.
 */
export function recordIncident(
  state: GameState,
  input: {
    resolveOpeningIds?: string[];
    kind: IncidentKind;
    reaction: ReactionInput;
    /** 당사자 — 감독이 부른 이름 그대로 올 수 있다 (`pickOurPlayer`) */
    playerIds: string[];
    intensity: 1 | 2 | 3;
    /** 무슨 일이었나 — 한 줄 */
    summary: string;
    /** 잔향 — 당사자에게 남는 심경 문장. `playerId`는 이름일 수 있다 */
    moods?: MoodNoteSubmission[];
  },
): CommandResult {
  const openingIds = [...new Set(input.resolveOpeningIds ?? [])];
  if (openingIds.some((id) => !state.openings.some((o) => o.id === id && o.resolvedOn === null)))
    return { ok: false, message: "해소할 시작 사건은 현재 열린 사건이어야 합니다" };
  const todayCount = state.narrative.filter(
    (n) => n.date === state.date && n.kind === "incident",
  ).length;
  if (todayCount >= MAX_INCIDENTS_PER_DAY) {
    return { ok: false, message: `오늘의 사건 한도(${MAX_INCIDENTS_PER_DAY}건)를 넘었습니다` };
  }
  const reaction = ReactionSchema.safeParse(input.reaction);
  if (!reaction.success) return { ok: false, message: "사건 반응은 -1~1 범위여야 합니다" };
  const summary = input.summary.trim();
  if (summary.length === 0 || summary.length > INCIDENT_SUMMARY_MAX) {
    return { ok: false, message: `요약은 1~${INCIDENT_SUMMARY_MAX}자여야 합니다` };
  }
  const resolved = input.playerIds.map((ref) => pickOurPlayer(state, ref));
  const missing = resolved.filter((r) => !r.ok);
  if (missing.length > 0) {
    return { ok: false, message: missing.map((r) => (r.ok ? "" : r.message)).join(" · ") };
  }
  const parties: GamePlayer[] = [];
  for (const r of resolved) {
    if (r.ok && !parties.some((p) => p.id === r.player.id)) parties.push(r.player);
  }
  if (parties.length === 0) return { ok: false, message: "당사자가 없습니다" };

  const effect = applySocialReaction(state, {
    reaction: reaction.data,
    band: INCIDENT_MORALE_BOUND,
    targetPlayerIds: parties.map((p) => p.id),
    axes: ["target", "team"],
  });
  const morale = effect.target;

  const salience = incidentSalience(input.intensity);
  // 인물 기억이 즉시 선다 — 선수의 characterId는 이름이다 (people.md §6 · §9-1)
  applyCharacterMemories(
    state,
    parties.map((p) => ({
      characterId: p.name,
      text: summary.slice(0, INCIDENT_MEMORY_MAX),
      salience,
    })),
  );
  pushNarrative(state, summary, salience, "incident");
  // 검증된 명시적 해소만 기록한다.
  for (const id of openingIds) {
    const line = resolveOpening(state, id, "handled");
    if (line) pushNarrative(state, line, 2);
  }
  state.incidents.push({
    date: state.date,
    kind: input.kind,
    playerIds: parties.map((p) => p.id),
    intensity: input.intensity,
    summary,
  });
  applyMoodNotes(state, resolveMoods(state, input.moods ?? []), new Set(parties.map((p) => p.id)));

  const names = parties.map((p) => p.name);
  const head = INCIDENT_KIND_KO[input.kind];
  return {
    ok: true,
    tone: morale >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${head} — ${names.join(", ")}` +
      ` · 사기 ${signed(morale)}` +
      (effect.team === 0 ? "" : ` · 팀 사기 ${signed(effect.team)}`),
    brief: {
      head,
      items: [
        item({ text: briefNames(names) }),
        ...deltaItems([
          ["사기", morale],
          ["팀 사기", effect.team],
        ]),
      ],
    },
  };
}

// ---- 판정형: team_talk — 감독의 말이 사기에 닿는 유일한 자리 ----

/**
 * **한 명과 마주 앉은 말**이 사기를 움직일 수 있는 폭 — 이벤트당 한도 (career.md §2).
 * 대상이 하나라 방 전체에 던진 말보다 깊이 닿는다.
 */
export const TALK_MORALE_BOUND = 8;

/**
 * **둘 이상이 들은 말**의 폭 — 한 사람을 부르는 것보다 좁다. 여기를 한 명의 폭과
 * 같게 두면 전원 소집이 면담을 완전히 대체한다.
 */
export const ROOM_MORALE_BOUND = 6;

/**
 * 정지점의 외침이 사기를 움직일 수 있는 폭 — **라커룸의 한마디보다 좁다**
 * (career.md §2). 같은 무게로 두면 라커룸 장면이 뜻을 잃는다.
 */
export const SHOUT_MORALE_BOUND = 2;

/**
 * 한 경기가 셈하는 외침의 수 (`PendingMatch.shouts`) — 정지점마다 외칠 수는 없다.
 * 셋을 다 써야 라커룸 한마디 한 번의 폭에 닿는다 (career.md §2).
 */
export const SHOUT_PER_MATCH = 3;

/**
 * **한 선수가 대화로 하루에 움직일 수 있는 사기의 합계** (career.md §2).
 *
 * 날짜 게이트가 있던 자리다 — 게이트는 그날의 두 번째 대화를 통째로 없는 말로 만들어,
 * 경기일 아침의 격려와 경기 뒤의 위로 중 뒤의 것이 사라졌다. 상한은 대화를 막지 않고
 * 그 대화가 판에 남기는 몫만 자른다.
 */
const TALK_DAILY_BOUND = 8;

/** 이레 동안의 합계 상한 — 매일 최고 판정을 받아도 사흘째에 여기서 멈춘다 */
const TALK_WEEKLY_BOUND = 20;

/** 합계를 세는 창 — 오늘을 포함한 이레 */
const TALK_WINDOW_DAYS = 7;

/**
 * **그 말이 울리는 방** — 둘 이상이 들었을 때만 걸리는 계수 (people.md §5-1).
 *
 * 경기 중에는 **그 경기의 명단**이 방이다 — 주장이 결장한 경기의 하프타임은
 * 부주장의 리더십이 계수를 정한다.
 */
export function matchSquadIds(state: GameState): ReadonlySet<string> | undefined {
  const pending = state.pendingMatch;
  if (!pending) return undefined;
  const side =
    pending.live.setup.sides.home.teamId === state.userTeamId
      ? pending.live.ledger.home
      : pending.live.ledger.away;
  return new Set([...side.onPitch, ...side.bench]);
}

/** 말을 꺼낸 자리 — 결과 항목의 머리가 그 자리를 밝힌다 */
export const OCCASION_KO: Record<TeamTalkOccasion, string> = {
  pre: "경기 전",
  half: "하프타임",
  post: "경기 후",
  daily: "평시",
  shout: "정지점",
};

/**
 * 0에서 멀어지는 쪽으로 반올림.
 *
 * `Math.round`는 절반을 위로 올려 `-0.5`를 0으로 만든다 — 같은 크기의 질책만 한 칸씩
 * 무뎌진다는 뜻이고, 폭이 ±2뿐인 외침에서는 그 비대칭이 라벨을 통째로 죽인다.
 */
export function roundAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * **합계 상한을 지나 실제로 남는 사기** (career.md §2).
 *
 * 하루와 이레의 남은 여유 중 좁은 쪽까지만 통과시키고, 통과한 만큼을 장부에 적는다.
 * 부호 있는 누계라 +8까지 올린 뒤 질책하면 다시 아래로 갈 자리가 생긴다 — 되풀이가
 * 아니라 뒤집기이므로 막지 않는다.
 */
export function creditTalkMorale(state: GameState, player: GamePlayer, delta: number): number {
  if (delta === 0) return 0;
  const from = addDays(state.date, -(TALK_WINDOW_DAYS - 1));
  const log = player.state.talkMorale.filter((row) => row.on >= from);
  const today = log.find((row) => row.on === state.date);
  const week = log.reduce((sum, row) => sum + row.sum, 0);
  const dayRoom = (delta > 0 ? TALK_DAILY_BOUND : -TALK_DAILY_BOUND) - (today?.sum ?? 0);
  const weekRoom = (delta > 0 ? TALK_WEEKLY_BOUND : -TALK_WEEKLY_BOUND) - week;
  const applied =
    delta > 0
      ? Math.max(0, Math.min(delta, dayRoom, weekRoom))
      : Math.min(0, Math.max(delta, dayRoom, weekRoom));
  if (applied === 0) {
    // 창 밖의 줄은 여기서도 걷는다 — 상한에 걸린 대화가 장부를 자라게 두지 않는다
    player.state.talkMorale = log;
    return 0;
  }
  if (today) today.sum += applied;
  else log.push({ on: state.date, sum: applied });
  player.state.talkMorale = log;
  return applied;
}

/** 감독이 그 자리에서 한 약속 — 갈래와, 감독이 좁힌 기한 */
export interface PromiseInput {
  kind: PromiseKind;
  /**
   * 기한(일) — 생략하면 갈래의 기본 기한이다. `number`는 날수가 아니라 다음 시즌
   * 개막일이다 (people.md §5-2).
   */
  days?: number;
  /**
   * 약속한 등번호 — **`number` 갈래에만 뜻이 있고, 그 갈래에는 없으면 반려된다.**
   * 번호가 곧 약속의 내용이라 그것 없이는 이행을 판정할 자가 없다.
   */
  number?: number;
}

/** 장부에 선 약속 한 조각 — 감독이 읽는 줄과 말풍선 항목 */
export interface PromisePiece {
  text: string;
  item: CommandBriefItem;
}

/** 대화의 인자 — 대상은 `players`가 정하고, 비우면 선수단 전체다 (career.md §2) */
export interface TalkInput {
  resolveIssues?: readonly { playerId: string; reason: PlayerIssueReason }[];
  /** 그 말을 꺼낸 자리 — `shout`만 경기가 센다 */
  occasion: TeamTalkOccasion;
  /**
   * 감독이 이름을 부른 사람들 — **생략하면 선수단 전체다.**
   * 이름·id 어느 표기든 걸리고, 풀리지 않는 이름은 결과 줄이 그대로 돌려준다.
   */
  players?: readonly string[];
  reaction: ReactionInput;
  /**
   * 감독이 이 대화에서 한 약속 — **상대가 한 명일 때만 장부에 선다**
   * (career.md §2 · people.md §5-2). 반려돼도 대화 자체는 그대로 성립한다.
   */
  promise?: PromiseInput;
  /** 잔향 — 그 말을 들은 선수에게 남는 심경 한 문장, 최대 `TEAM_TALK_MOODS` (people.md §5) */
  moods?: MoodNoteSubmission[];
}

// ---- 사건 기록: 감독이 말로 만든 사건이 장부에 서는 자리 (people.md §6) ----

/** 하루에 세울 수 있는 사건 수 — 서사 줄의 갈래(`incident`)로 센다 */
export const MAX_INCIDENTS_PER_DAY = 3;

/** 한 사건이 당사자의 사기를 움직일 수 있는 폭 — 면담 한 번(±8)보다 좁다 */
export const INCIDENT_MORALE_BOUND = 6;

/** 요약의 상한 — `IncidentSchema.summary`와 같은 수 */
export const INCIDENT_SUMMARY_MAX = 200;

/** 인물 기억 한 줄의 상한 — `CharacterMemorySchema.text`와 같은 수. 요약이 길면 여기서 접는다 */
export const INCIDENT_MEMORY_MAX = 120;

/** 세기 → 서사·기억의 무게 (1→2 · 2→3 · 3→4) */
export const incidentSalience = (intensity: 1 | 2 | 3): number => intensity + 1;
