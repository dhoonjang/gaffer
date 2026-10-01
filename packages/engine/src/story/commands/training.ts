import {
  type GameState,
  squadLevelOf,
  pushNarrative,
  type CommandBriefItem,
  userPlayers,
} from "../../common/core/state";
import { type CommandResult } from "../../common/commands/result";
import {
  type GamePlayer,
  josa,
  AXIS_KO,
  type ScheduleEntry,
  type Slot,
  type TrainAttr,
  SLOT_TIME,
  clampCondition,
  slotOfTime,
  attributeAxisOf,
  positionGroupOf,
  ATTRIBUTE_AXES,
} from "@story-fm/domain";
import { pickOurPlayer } from "../../common/core/player-ref";
import { DEVELOPMENT_FOCUS_LIMIT, pruneDevelopmentFocus } from "../players/development";
import { briefNames, item } from "../../common/commands/brief";
import { squadReturnOf, sortEntries } from "../../common/core/calendar";
import { diffDays, addDays } from "../../common/core/dates";

/**
 * 집중 육성 — 감독이 코치진의 눈을 둘 2군 유망주를 지정한다 (season.md §2 2군 리그).
 *
 * **목록 교체다** — 부를 때마다 지정 전체를 다시 적고, 목록을 생략하면 해제다. 더하기·
 * 빼기를 따로 받으면 감독이 지금 명단을 모른 채 상한에 걸린다. 우리 2군만 지정할
 * 수 있고, 승격하면 풀린다(`applySquadLevel`) — 1군은 결산 판정(LLM)의 몫이라
 * 코어 배율이 닿을 자리가 없다.
 */
export function setDevelopmentFocus(
  state: GameState,
  input: { playerIds?: string[] },
): CommandResult {
  const players: GamePlayer[] = [];
  for (const id of input.playerIds ?? []) {
    const pick = pickOurPlayer(state, id);
    if (!pick.ok) return pick;
    const player = pick.player;
    if (squadLevelOf(player) !== "reserve") {
      return {
        ok: false,
        message: `${josa(player.name, "은/는")} 1군입니다 — 집중 육성은 2군 유망주에게 겁니다`,
      };
    }
    if (!players.some((p) => p.id === player.id)) players.push(player);
  }
  if (players.length > DEVELOPMENT_FOCUS_LIMIT) {
    return {
      ok: false,
      message: `집중 육성은 ${DEVELOPMENT_FOCUS_LIMIT}명까지입니다 — 코치진의 눈은 거기까지 닿습니다`,
    };
  }

  const before = pruneDevelopmentFocus(state);
  const after = players.map((p) => p.id);
  if (before.length === after.length && before.every((id) => after.includes(id))) {
    return {
      ok: true,
      unchanged: true,
      message:
        players.length === 0
          ? "집중 육성 지정이 없습니다"
          : `이미 그 명단입니다 — ${briefNames(players.map((p) => p.name))}`,
    };
  }
  state.developmentFocus = after;
  if (players.length === 0) {
    return {
      ok: true,
      message: "집중 육성 지정을 해제했습니다",
      brief: { head: "집중 육성", items: [item({ text: "해제" })] },
    };
  }
  pushNarrative(state, `집중 육성 지정 — ${players.map((p) => p.name).join(", ")}`, 1);
  return {
    ok: true,
    message: `집중 육성: ${players.map((p) => p.name).join(", ")} — 2군 경기 출전이 성장을 끌어올립니다`,
    brief: {
      head: "집중 육성",
      items: [item({ label: "지정", text: briefNames(players.map((p) => p.name)) })],
    },
  };
}

/** 미래(오늘 포함) 예정 훈련 엔트리만 조작 대상 — 지난 훈련은 이력이다 */
function futureTraining(state: GameState): ScheduleEntry[] {
  return state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  );
}

function addTrainingEntry(
  state: GameState,
  date: string,
  slot: Slot,
  label: string,
  focus: TrainAttr[],
): void {
  const time = SLOT_TIME[slot];
  // 같은 날 같은 슬롯은 덮어쓴다
  const dupes = new Set(
    state.schedule
      .filter(
        (e) =>
          e.type === "training" && e.date === date && e.time === time && e.status === "scheduled",
      )
      .map((e) => e.refId),
  );
  state.schedule = state.schedule.filter(
    (e) =>
      !(e.type === "training" && e.date === date && e.time === time && e.status === "scheduled"),
  );
  state.trainingSessions = state.trainingSessions.filter((s) => !dupes.has(s.id));

  const sessionId = `ts-${date}-${slot}`;
  state.trainingSessions.push({ id: sessionId, label, focus: [...focus] });
  state.schedule.push({
    id: `se-${sessionId}`,
    date,
    time,
    type: "training",
    refId: sessionId,
    teamId: state.userTeamId,
    status: "scheduled",
  });
}

function recallSquadEarly(state: GameState, date: string): string {
  const was = squadReturnOf(state.calendar);
  const early = Math.max(1, diffDays(date, was));
  state.calendar.squadReturn = date;

  const drain = Math.round(early * RECALL_DRAIN_PER_DAY);
  const players = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  for (const p of players) {
    p.state.condition = clampCondition(p.state.condition - drain);
  }

  /**
   * 반발하는 선수 — 당긴 날수에 비례하되 스쿼드의 절반을 넘지 않는다.
   * 대상은 시드가 아니라 **가장 지친 선수부터**다. 쉬어야 할 사람이 먼저 화낸다.
   */
  const upset = Math.min(
    Math.floor(players.length * RECALL_UPSET_CAP_SHARE),
    Math.max(0, Math.round(early / RECALL_DAYS_PER_UPSET)),
  );
  const already = new Set(state.issues.map((i) => i.gamePlayerId));
  const angry = [...players]
    .sort((a, b) => a.state.condition - b.state.condition)
    .filter((p) => !already.has(p.id))
    .slice(0, upset);
  for (const p of angry) {
    state.issues.push({
      gamePlayerId: p.id,
      kind: "unhappy",
      reason: "early-return",
      since: state.date,
    });
  }

  pushNarrative(state, `휴가 반납 소집 ${was}→${date} · 불만 ${angry.length}명`, 4);
  return (
    `소집을 ${early}일 앞당겼습니다 (${was} → ${date}) — 선수단 체력 −${drain}` +
    (angry.length > 0 ? `, ${angry.length}명이 불만을 품었습니다` : ", 큰 반발은 없었습니다")
  );
}

export function setTraining(state: GameState, input: TrainingPlanInput): CommandResult {
  const applied: string[] = [];
  /**
   * 말풍선 항목 — **건수와 갈래까지만.** 세션 하나하나를 적으면(월·수·금이면 셋)
   * 알림이 달력 화면을 옮겨 적는 자리가 된다. 조기 소집 대가·휴가 건너뜀은
   * `message`에 남아 GM이 장면으로 푼다.
   */
  const items: CommandBriefItem[] = [];
  const sessions = input.sessions ?? [];
  const repeats = input.repeatWeekly ?? [];

  // ── 검증 ───────────────────────────────────────────────
  // 여기서는 아무것도 바꾸지 않는다. 하나라도 걸리면 상태는 부른 그대로다
  // (→ docs/common/season.md §4). 조기 소집은 체력을 깎고 불만을 남기고 소집일을
  // 옮기는 **되돌릴 수 없는** 걸음이라, 그 뒤에서 세션 하나가 걸리면 "반려했습니다"를
  // 읽은 감독의 선수단이 이미 지쳐 있었다.

  /**
   * **지난 날짜에는 훈련을 잡지 못한다.**
   *
   * 그 자리의 tick은 이미 지나갔으므로 엔트리가 영영 `scheduled`로 남아 달력에
   * "예정"으로 서고, 같은 날짜가 조기 소집으로 흘러가면 대가(`recallSquadEarly`)가
   * 오늘까지의 날수만큼 부풀려 매겨진다.
   */
  for (const s of sessions) {
    if (!DATE_RE.test(s.date)) return { ok: false, message: `날짜 형식이 잘못됨: ${s.date}` };
    if (s.date < state.date) {
      return {
        ok: false,
        message: `${josa(s.date, "은/는")} 이미 지난 날입니다 — 훈련은 오늘(${state.date})부터 잡을 수 있습니다`,
      };
    }
    if (!s.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(s.focus);
    if (err) return { ok: false, message: err };
  }
  for (const r of repeats) {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) {
      return { ok: false, message: `요일이 잘못됨: ${r.dow} (0~6)` };
    }
    if (!r.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(r.focus);
    if (err) return { ok: false, message: err };
  }

  /**
   * **여름 휴가엔 훈련이 없다 — 감독이 소집을 앞당기지 않는 한.**
   *
   * 소집일 전까지 선수단은 구단에 없다. 실수로 그 자리에 세션이 깔리는 것은
   * 막아야 하지만(부임 첫날 "월·수·금 훈련"이 그대로 통과하던 문제), **막는 것과
   * 못 하게 하는 것은 다르다.** 휴가를 깨고 부르는 것은 실제 감독이 할 수 있는
   * 일이고, 대가는 선수단의 반발이다 — 코어는 가능하게 하고 값을 물린다.
   *
   * 그래서 `recallSquad` 없이는 거부하고, 있으면 소집일 자체를 앞당긴다. 여기서는
   * **앞당겼다고 치면 언제인가**만 구한다 — 옮기는 것은 아래 적용 단계다.
   */
  const squadReturn = squadReturnOf(state.calendar);
  const wanted = [...sessions.map((x) => x.date), ...(repeats.length > 0 ? [state.date] : [])];
  const earliest = [...wanted].sort()[0];
  const recallTo =
    input.recallSquad === true && earliest !== undefined && earliest < squadReturn
      ? earliest
      : undefined;
  const effectiveReturn = recallTo ?? squadReturn;
  for (const s of sessions) {
    if (s.date < effectiveReturn) {
      return {
        ok: false,
        message:
          `${josa(s.date, "은/는")} 선수단 여름 휴가 기간입니다 — 훈련은 소집일(${effectiveReturn})부터 잡을 수 있습니다. ` +
          `감독이 휴가를 접고 조기 소집하겠다고 했다면 recallSquad를 함께 보내세요 (선수단이 반발합니다).`,
      };
    }
  }

  // ── 적용 ───────────────────────────────────────────────

  /**
   * 1) 비우기 먼저 — "월요일 훈련 다 지우고 새로" 같은 지시를 한 번에 처리.
   *
   * **`clearTraining`과 같은 규칙을 쓴다** — 두 경로가 갈리면 "쉬게 하자"와
   * "훈련 빼줘"가 서로 다르게 처리되고, 휴식 세션을 남기지 않은 쪽은 다음 tick이
   * 기본 훈련을 도로 깐다.
   *
   * 적용의 **첫 걸음**이라 여기 반려는 아직 아무것도 바꾸지 않았다 — `clearTraining`
   * 자신도 검증을 다 끝낸 뒤에 지운다.
   */
  if (input.clear) {
    const opt = input.clear === true ? {} : input.clear;
    /**
     * 범위의 기본값이 다르다 — 여기 `clear`는 **그 뒤 전부**를 비우는 뜻이고
     * (`clear: true` = "당분간 훈련 없다"), 날짜를 콕 집는 쪽은 `to`를 준다.
     * 그대로 넘기면 하루만 지워져 "전부 비우기"가 조용히 하루짜리가 된다.
     */
    const cleared = clearTraining(state, {
      ...opt,
      to: opt.to ?? addDays(state.date, CLEAR_TRAINING_HORIZON_DAYS),
    });
    if (!cleared.ok) return cleared;
    applied.push(cleared.message);
    items.push(...(cleared.brief?.items ?? []));
  }

  if (recallTo !== undefined) applied.push(recallSquadEarly(state, recallTo));

  // 2) 특정 날짜 세션
  const dated: Array<{ date: string; slot: Slot }> = [];
  const datedFocus = new Set<TrainAttr>();
  for (const s of sessions) {
    addTrainingEntry(state, s.date, s.slot, s.label.trim(), s.focus);
    applied.push(`${s.date} ${slotKo(s.slot)}=${s.label}${focusKo(s.focus)}`);
    dated.push({ date: s.date, slot: s.slot });
    for (const f of s.focus) datedFocus.add(f);
  }
  const firstDated = dated[0];
  if (firstDated) {
    // 날짜 세션은 첫 자리 + 나머지 건수로 접는다 — 어느 날 무엇을 하는지는 달력이 갖고 있다
    items.push(
      // 이름표를 달지 않는다 — `9-03 오전`도 `매주 3회`도 어느 갈래인지를 값이 이미 말한다
      item({
        text:
          `${briefDate(firstDated.date)} ${slotKo(firstDated.slot)}` +
          (dated.length > 1 ? ` 외 ${dated.length - 1}건` : ""),
        note: briefFocus(datedFocus),
      }),
    );
  }

  // 3) 요일 반복 — 오늘부터 weeks주만큼 엔트리를 펼친다
  const weeks = Math.max(
    REPEAT_WEEKS_MIN,
    Math.min(REPEAT_WEEKS_MAX, input.weeks ?? REPEAT_WEEKS_DEFAULT),
  );
  /** 요일 반복은 **하나로 묶는다** — 월·수·금이 항목 셋이 되면 그게 글자 벽이다 */
  let repeatPerWeek = 0;
  let repeatWeeks = 0;
  const repeatFocus = new Set<TrainAttr>();
  for (const r of repeats) {
    let made = 0;
    let skipped = 0;
    // 휴가 중이면 소집일부터 센다 — "3주간 반복"은 훈련할 수 있는 3주를 뜻한다
    const from = state.date < effectiveReturn ? effectiveReturn : state.date;
    if (state.date < effectiveReturn) skipped = diffDays(state.date, effectiveReturn);
    for (let d = 0; d < weeks * 7 && made < weeks; d++) {
      const date = addDays(from, d);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== r.dow) continue;
      addTrainingEntry(state, date, r.slot, r.label.trim(), r.focus);
      made++;
    }
    applied.push(
      `매주 ${WEEKDAY_KO[r.dow]}요일 ${slotKo(r.slot)}=${r.label}${focusKo(r.focus)} × ${made}주` +
        (skipped > 0 ? ` (휴가 ${skipped}일을 건너뛰고 ${from}부터)` : ""),
    );
    repeatPerWeek++;
    repeatWeeks = Math.max(repeatWeeks, made);
    for (const f of r.focus) repeatFocus.add(f);
  }
  if (repeatPerWeek > 0) {
    items.push(
      item({
        text: `매주 ${repeatPerWeek}회 × ${repeatWeeks}주`,
        note: briefFocus(repeatFocus),
      }),
    );
  }

  state.schedule = sortEntries(state.schedule);
  return {
    ok: true,
    message: applied.length > 0 ? `훈련 지정 — ${applied.join(", ")}` : "변경할 훈련이 없습니다",
    ...(items.length > 0 ? { brief: { head: "훈련 지정", items } } : {}),
  };
}

export function clearTraining(state: GameState, input: ClearTrainingInput): CommandResult {
  const from = input.from ?? state.date;
  const to = input.to ?? from;
  if (!DATE_RE.test(from)) return { ok: false, message: `날짜 형식이 잘못됨: ${from}` };
  if (!DATE_RE.test(to)) return { ok: false, message: `날짜 형식이 잘못됨: ${to}` };
  if (to < from) return { ok: false, message: `종료일이 시작일보다 빠릅니다: ${from} ~ ${to}` };
  if (input.dow !== undefined && (!Number.isInteger(input.dow) || input.dow < 0 || input.dow > 6)) {
    return { ok: false, message: `요일이 잘못됨: ${input.dow} (0~6)` };
  }
  // 지난 훈련은 이력이라 건드리지 않는다 — 오늘 이전은 조용히 잘라낸다
  const start = from < state.date ? state.date : from;
  const asRest = input.rest !== false;

  const targets = futureTraining(state).filter((e) => {
    if (e.date < start || e.date > to) return false;
    if (input.dow !== undefined && new Date(`${e.date}T00:00:00Z`).getUTCDay() !== input.dow) {
      return false;
    }
    if (input.slot !== undefined && e.time !== SLOT_TIME[input.slot]) return false;
    return true;
  });

  const ids = new Set(targets.map((e) => e.refId));
  const removed = new Set(targets);
  state.schedule = state.schedule.filter((e) => !removed.has(e));
  state.trainingSessions = state.trainingSessions.filter((s) => !ids.has(s.id));

  /**
   * 휴식 표식은 **비운 자리마다** 세운다. 원래 훈련이 없던 날(주말·MD+2)에는
   * 세우지 않는다 — 이미 쉬는 날이라 표식이 없어도 기본 배치가 안 들어온다.
   */
  const days = new Set<string>();
  if (asRest) {
    for (const e of targets) {
      const sessionId = `ts-rest-${e.date}-${slotOfTime(e.time)}`;
      state.trainingSessions.push({ id: sessionId, label: "휴식", focus: [], rest: true });
      state.schedule.push({
        id: `se-${sessionId}`,
        date: e.date,
        time: e.time,
        type: "training",
        refId: sessionId,
        teamId: state.userTeamId,
        status: "scheduled",
      });
      days.add(e.date);
    }
  }

  state.schedule = sortEntries(state.schedule);
  if (targets.length === 0) {
    return { ok: true, message: "그 기간에 예정된 훈련이 없습니다" };
  }
  const span = start === to ? start : `${start}~${to}`;
  const briefSpan = briefSpanOf(start, to);
  return {
    ok: true,
    message: asRest
      ? `${span} 훈련 ${targets.length}건을 휴식으로 (${days.size}일)`
      : `${span} 훈련 ${targets.length}건 취소 — 기본 훈련이 다시 편성됩니다`,
    brief: {
      head: "훈련 비우기",
      items: [
        item({
          label: asRest ? "휴식" : "취소",
          text: `${briefSpan} ${targets.length}건`,
        }),
      ],
    },
  };
}

/**
 * 개인 훈련 — **팀 훈련 위에 한 선수만 겨냥해 얹는다.**
 *
 * 축(`axis`)도 자리(`position`)도 훈련 결산(LLM)의 입력이고, 자리는 결산 한 번에
 * `POSITION_TRAIN_MAX`까지만 오른다 — **실전보다 느리게**(경기 1회 = +1).
 * "자리는 커리어가 만든다"를 지키되 전향이라는 판단이 가능해진다.
 *
 * **휴식(`rest`)은 그 위의 셋째 갈래다** — 감독이 기간을 정해 이 선수를 훈련에서
 * 뺀다 (season.md §4 · player.md §5.5). 축·자리와 서로를 지우지 않는다: 쉬는 것과
 * 무엇을 배우는지는 다른 지시이고, 한쪽만 보낸 요청이 다른 쪽을 조용히 거두면
 * 감독이 걸어 둔 전향이 "이번 주 쉬게 해" 한마디에 사라진다.
 *
 * ⚠️ **층마다 닿는 것이 다르다** (season.md §2). 2군은 결산을 받지 않으므로 축은
 * 월간 성장의 겨냥으로 넘어가고, **자리는 갈 곳이 없어 반려한다** — 걸어 두고
 * 기다리게 하는 것이 거짓 성공이다.
 */
export function setPlayerTraining(
  state: GameState,
  input: {
    playerId: string;
    axis?: string;
    position?: string;
    rest?: { until: string };
    clear?: boolean;
  },
): CommandResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;
  const index = state.playerTraining.findIndex((t) => t.gamePlayerId === player.id);

  if (input.clear || (!input.axis && !input.position && !input.rest)) {
    if (index < 0) return { ok: false, message: `${player.name}에게 걸린 개인 훈련이 없습니다` };
    state.playerTraining.splice(index, 1);
    return {
      ok: true,
      message: `${player.name}의 개인 훈련을 거뒀습니다`,
      brief: { head: `${player.name} 개인 훈련`, items: [item({ text: "거둠" })] },
    };
  }

  // ── 검증 ── 여기서는 아무것도 바꾸지 않는다 (season.md §4 — `setTraining`과 같은 규약)
  const axis = attributeAxisOf(input.axis?.trim());
  if (input.axis?.trim() && !axis) {
    return { ok: false, message: `알 수 없는 능력치 축: ${input.axis.trim()}` };
  }
  const position = input.position?.toUpperCase();
  if (position && !positionGroupOf(position)) {
    return { ok: false, message: `알 수 없는 포지션: ${input.position}` };
  }
  // 반려는 요청 전체에 걸린다 — 자리만 떼고 축만 걸면 감독이 시킨 적 없는 훈련이 선다
  if (position && squadLevelOf(player) === "reserve") {
    return {
      ok: false,
      message: `${josa(player.name, "은/는")} 2군이라 자리를 배울 수 없습니다 — 자리는 훈련 결산이 올리고 2군은 결산을 받지 않습니다. 1군으로 올린 뒤에 거세요`,
    };
  }
  const restUntil = input.rest?.until;
  if (restUntil !== undefined) {
    if (!DATE_RE.test(restUntil)) {
      return { ok: false, message: `날짜 형식이 잘못됨: ${restUntil}` };
    }
    if (restUntil < state.date) {
      return {
        ok: false,
        message: `${josa(restUntil, "은/는")} 이미 지난 날입니다 — 휴식은 오늘(${state.date})까지로만 끊을 수 있습니다`,
      };
    }
    const days = diffDays(state.date, restUntil) + 1;
    if (days > PLAYER_REST_MAX_DAYS) {
      return {
        ok: false,
        message: `${days}일은 너무 깁니다 — 개인 휴식은 ${PLAYER_REST_MAX_DAYS}일까지입니다. 그보다 오래 빼려면 2군으로 내리세요`,
      };
    }
  }

  // ── 적용 ──
  const before = index >= 0 ? state.playerTraining[index] : undefined;
  const program = {
    gamePlayerId: player.id,
    // 주지 않은 갈래는 지금 값을 그대로 잇는다 — 서로를 지우지 않는다
    ...(axis ? { axis } : before?.axis ? { axis: before.axis } : {}),
    ...(position ? { position } : before?.position ? { position: before.position } : {}),
    ...(restUntil ? { rest: { until: restUntil } } : before?.rest ? { rest: before.rest } : {}),
    since: state.date,
  };
  if (index >= 0) state.playerTraining[index] = program;
  else state.playerTraining.push(program);

  const parts: string[] = [];
  const items: CommandBriefItem[] = [];
  if (axis) {
    const ko = AXIS_KO[axis];
    parts.push(ko);
    items.push(item({ label: "능력치", text: ko }));
  }
  if (position) {
    const fit = player.positions.find((p) => p.position === position)?.proficiency ?? 0;
    parts.push(`${position} 전향 (지금 적응도 ${fit})`);
    items.push(item({ label: "전향", text: position, note: `적응도 ${fit}` }));
  }
  if (restUntil) {
    const days = diffDays(state.date, restUntil) + 1;
    parts.push(`${restUntil}까지 훈련 제외 (${days}일)`);
    items.push(item({ label: "휴식", text: `~${briefDate(restUntil)}`, note: `${days}일` }));
  }
  // 어디에 닿는지까지 답한다 — 층에 따라 경로가 갈린다 (season.md §2)
  const where = squadLevelOf(player) === "reserve" ? " (2군 — 월간 성장의 축 배율)" : "";
  return {
    ok: true,
    message: `${player.name} 개인 훈련 — ${parts.join(" · ")}${where}`,
    brief: { head: `${player.name} 개인 훈련`, items },
  };
}

// ---- 훈련: 명령이 일정 엔트리를 직접 생성한다 (규칙 테이블 없음) ----

const TRAIN_ATTRS: TrainAttr[] = [...ATTRIBUTE_AXES, "tactical", "recovery"];

export const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

const TRAIN_ATTR_KO: Record<string, string> = {
  ...AXIS_KO,
  tactical: "전술",
  recovery: "회복",
};

export interface TrainingPlanInput {
  /** 특정 날짜 세션 */
  sessions?: Array<{ date: string; slot: Slot; label: string; focus: TrainAttr[] }>;
  /** 요일 반복 — 지정 주 수만큼 엔트리를 펼쳐서 만든다 (기본 6주) */
  repeatWeekly?: Array<{ dow: number; slot: Slot; label: string; focus: TrainAttr[] }>;
  /** 반복 생성 주 수 (기본 6) */
  weeks?: number;
  /** 미래 훈련 비우기 — 날짜/요일 지정 시 그 대상만, 없으면 전부 */
  clear?: { from?: string; to?: string; dow?: number; slot?: Slot; rest?: boolean } | true;
  /**
   * **휴가를 접고 선수단을 조기 소집한다.** 감독이 명시적으로 그러겠다고 했을 때만.
   * 소집일 자체가 앞당겨지고, 선수단은 체력을 잃고 일부는 불만을 품는다.
   */
  recallSquad?: boolean;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validFocus(focus: TrainAttr[]): string | null {
  for (const f of focus) {
    if (!TRAIN_ATTRS.includes(f)) return `훈련 focus가 잘못됨: ${f} (${TRAIN_ATTRS.join("/")})`;
  }
  return null;
}

export function focusKo(focus: TrainAttr[]): string {
  return focus.length > 0 ? `(${focus.map((f) => TRAIN_ATTR_KO[f] ?? f).join("·")})` : "";
}

export const slotKo = (slot: Slot): string => (slot === "am" ? "오전" : "오후");

/** 항목에 적는 날짜 — 연도를 뗀다 (`2026-09-03` → `9-03`). 어느 해인지는 달력이 안다 */
export function briefDate(date: string): string {
  return `${Number(date.slice(5, 7))}-${date.slice(8, 10)}`;
}

/**
 * 항목에 적는 **기간** — 연도를 떼되 **해를 넘으면 뒤에 해를 붙인다.**
 *
 * `clear: true`는 400일 뒤까지 비운다. 연도를 그냥 떼면 `7-01~8-05`가 되어 다섯 주로
 * 읽히는데 실제로는 열세 달이다 — 짧게 적으려다 거짓을 적는 자리다.
 */
export function briefSpanOf(from: string, to: string): string {
  if (from === to) return briefDate(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${briefDate(from)}~${sameYear ? "" : `'${to.slice(2, 4)} `}${briefDate(to)}`;
}

/** 항목에 적는 훈련 갈래 — 둘에서 접는다. 닫힌 enum이라 길이가 예측된다(자유 label은 안 쓴다) */
const FOCUS_SHOWN = 2;

export function briefFocus(focus: Iterable<TrainAttr>): string {
  const kinds = [...new Set(focus)].map((f) => TRAIN_ATTR_KO[f] ?? f);
  if (kinds.length === 0) return "";
  const shown = kinds.slice(0, FOCUS_SHOWN).join("·");
  return `${shown}${kinds.length > FOCUS_SHOWN ? ` 외 ${kinds.length - FOCUS_SHOWN}` : ""}`;
}

/**
 * 훈련 지정 — 자연어 label + focus(효과 대상). 특정 날짜(sessions) 또는
 * 요일 반복(repeatWeekly)으로 받고, 명령이 그 즉시 SCHEDULE_ENTRY를 생성한다.
 * 반복은 규칙으로 남지 않고 실제 일정으로 펼쳐진다 (v6 — 일정이 단일 원본).
 */
/**
 * **휴가를 접고 선수단을 조기 소집한다** — 감독이 치를 값이 있는 선택.
 *
 * 코어는 길을 막지 않고 **대가를 물린다**. 무엇이 대가인가:
 *   ① 쉬지 못한 몸 — 당긴 날수만큼 체력이 깎인 채로 프리시즌을 시작한다
 *   ② 라커룸의 반발 — 일부 선수에게 불만이 남는다 (방치하면 매일 갉힌다)
 * 둘 다 감독이 **되돌릴 수 있는** 것이다 — 회복 훈련으로 몸을, 면담·팀토크로
 * 마음을 되찾는다. 그게 이 게임에서 강행이 "금지"가 아니라 "선택"인 이유다.
 *
 */
/** 하루를 당길 때마다 깎이는 체력 */
export const RECALL_DRAIN_PER_DAY = 1.2;

/** 며칠을 당겨야 한 명이 등을 돌리는가 */
export const RECALL_DAYS_PER_UPSET = 3;

/** 반발이 번질 수 있는 1군의 최대 비율 — 라커룸 전체가 등을 돌리지는 않는다 */
export const RECALL_UPSET_CAP_SHARE = 0.5;

/**
 * "훈련 다 지워"가 미치는 앞날 — 끝 날짜를 주지 않은 비우기의 지평이다.
 * 한 시즌보다 넉넉해 "전부"로 읽히면서도, 일정 전체를 훑지는 않는 폭.
 */
export const CLEAR_TRAINING_HORIZON_DAYS = 400;

/** 요일 반복을 펼치는 주 수 — 말하지 않으면 이만큼, 그 아래·위로는 자른다 */
export const REPEAT_WEEKS_DEFAULT = 6;

export const REPEAT_WEEKS_MIN = 1;

export const REPEAT_WEEKS_MAX = 20;

/**
 * 훈련 비우기 — **"이 날은 쉬자"를 상태로 남긴다.**
 *
 * 지우기만 해서는 지시가 하루도 못 간다: 휴식은 원래 엔트리 부재로 표현되므로
 * (기본 훈련의 MD+2·주말) 비운 자리를 `syncDefaultTraining`이 "아직 안 깐 날"로
 * 읽고 다음 tick에 기본 훈련을 도로 깐다. 그래서 기본값은 **휴식 세션을 남기는
 * 것**이고(`rest`), 그 자리는 기본 배치가 못 들어오는 자리가 된다.
 *
 * `rest: false`는 뜻이 다르다 — "내가 잡은 훈련 취소하고 원래대로"다. 자리를
 * 비우기만 하므로 기본 훈련이 제자리로 돌아온다.
 *
 * 범위는 **좁은 쪽이 기본**이다: `to`를 안 주면 `from` 하루만, `from`도 안 주면
 * 오늘 하루. 훈련 일정은 시즌 전체가 깔려 있어서, 기본이 넓으면 "내일 쉬자"
 * 한마디에 시즌이 통째로 비워진다.
 */
export interface ClearTrainingInput {
  /** 시작일 (기본 오늘) */
  from?: string;
  /** 종료일 (기본 from과 같은 날 — 하루만) */
  to?: string;
  /** 이 요일만 (0=일 ~ 6=토) */
  dow?: number;
  /** 이 슬롯만 — 없으면 그날 전부 */
  slot?: Slot;
  /** 쉬는 날로 못 박을 것인가 (기본 true). false면 기본 훈련이 다시 들어온다 */
  rest?: boolean;
}

/**
 * **한 선수를 기간을 정해 훈련에서 뺄 수 있는 최장 길이** (→ docs/common/season.md §4).
 *
 * 한 달을 넘기는 것은 훈련 조정이 아니라 스쿼드에서 빼는 결정이고, 그 손잡이는
 * 2군(`set_squad_level`)이다. 상한이 없으면 "당분간 쉬게 해"가 시즌 끝까지 걸린
 * 프로그램이 되어 감독이 잊은 채 반년이 지난다.
 */
export const PLAYER_REST_MAX_DAYS = 28;
