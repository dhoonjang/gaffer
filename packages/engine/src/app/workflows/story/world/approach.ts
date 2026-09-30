import {
  APPROACH_CHANNEL_LABEL,
  APPROACH_PATIENCE_DAYS,
  type Approach,
  type ApproachContext,
  type ApproachTopic,
  type GamePlayer,
  type PlayerIssue,
  type PressFact,
  type ReactionInput,
  ReactionSchema,
  type TickSink,
  approachContextText,
  isIssueTopic,
  josa,
} from "@story-fm/domain";
import { deltaItems } from "../../../../common/commands/brief";
import { type CommandResult } from "../../../../common/commands/result";
import { diffDays } from "../../../../common/core/dates";
import { pickOurPlayer } from "../../../../common/core/player-ref";
import {
  type GameState,
  managedTeamId,
  pendingApproach,
  playerById,
  pushApproach,
  pushNarrative,
  seasonStatOf,
  userPlayers,
} from "../../../../common/core/state";
import { ownerOf } from "../../../../common/people/persona";
import { squadStatusOf, startsInWindow } from "../../../../common/players/contract-status";
import { formLabel } from "../../../../common/players/form";
import { leaderGroupOf, leaderRoleOf } from "../../../../common/players/hierarchy";
import { type MoodLine, applyMoodNotes } from "../../../../common/players/mood-notes";
import { openPromise } from "../../../../common/players/promises";
import { type PromiseInput, promisePiece, recordIncident } from "../../../../story/commands/talk";
import { recentOutcomes } from "../../../../story/players/slump";
import {
  APPROACH_WINLESS_WINDOW,
  CHANNEL_OF,
  REVIEW_WINDOW_DAYS,
  SQUAD_SUBJECT,
  type Scene,
  closeApproach,
  contextTextOf,
  effectSuffix,
  expireApproach,
  firstTeamForm,
  issueDays,
  lastBrokenPromise,
} from "../../../../story/world/approach";
import { pendingPress } from "../../../../story/world/press";

/** 선수 채널의 사실 — 불만 한 조각과 지금의 폼. 그 밖은 이 사람이 말할 것이 아니다 */
function playerFacts(
  state: GameState,
  player: GamePlayer,
  issue: PlayerIssue,
  topic: ApproachTopic,
  sharp: boolean,
): PressFact[] {
  const days = issueDays(state, issue);
  const head: PressFact = ((): PressFact => {
    switch (topic) {
      case "minutes": {
        const apps = seasonStatOf(state, player.id)?.apps ?? 0;
        /**
         * **그가 아는 것은 시즌 출전 수만이 아니다** (people.md §5·§5-2) — 자기가
         * 어떤 자리로 왔는지(계약 지위)와 최근 창에서 몇 번 섰는지가 그 불만의
         * 근거다. 이 셋이 없으면 백업의 침묵과 핵심의 불만이 같은 카드로 선다.
         *
         * 창의 출전 수(`windowApps`)가 선발 수와 나란히 서는 것은 **벤치에만 앉아
         * 있던 사람과 교체로는 뛴 사람이 다른 말을 하기 때문이다** — 선발 수만
         * 실으면 후반 45분을 뛴 선수의 카드가 한 번도 못 뛴 선수의 카드와 같다.
         * 시즌 누계인 `apps`와 창의 것을 두 이름으로 두는 것도 그래서다.
         */
        const read = startsInWindow(state, player);
        return {
          kind: "minutes",
          data: {
            values: {
              days,
              apps,
              starts: read.starts,
              played: read.played,
              windowApps: read.apps,
            },
            tags: [squadStatusOf(state, player)],
          },
          about: player.id,
          sharp,
        };
      }
      case "demotion": {
        const since = player.state.demotedOn;
        const down = since ? diffDays(since, state.date) : days;
        return {
          kind: "demoted",
          data: { values: { days: down, issueDays: days } },
          about: player.id,
          sharp,
        };
      }
      default: {
        /**
         * 어긴 약속은 사유 코드만으로 서지 않는다 (people.md §5-2) — **무엇을**
         * 약속했고 그것이 **며칠 전**이었나가 그 선수가 아는 사실이다. 장부에서
         * 마지막으로 깨진 줄을 읽는다: 그 자리를 연 것이 그 줄이기 때문이다.
         * 다른 사유의 카드에는 붙지 않는다.
         */
        const broken = topic === "promise" ? lastBrokenPromise(state, player.id) : null;
        return {
          kind: "unhappy",
          data: {
            values: { days, ...(broken ? { promised: diffDays(broken.madeOn, state.date) } : {}) },
            tags: ["grievance", issue.reason, ...(broken ? [broken.kind] : [])],
          },
          about: player.id,
          sharp,
        };
      }
    }
  })();
  return [
    head,
    {
      kind: "slump",
      data: { tags: [formLabel(player.state.form)] },
      about: player.id,
      sharp: false,
    },
  ];
}

function sceneFor(state: GameState, row: { subject: string; topic: ApproachTopic }): Scene | null {
  const channel = CHANNEL_OF[row.topic];
  const sharp = false;

  if (isIssueTopic(row.topic)) {
    const player = playerById(state, row.subject);
    const issue = state.issues.find(
      (i) => i.gamePlayerId === row.subject && i.reason === row.topic,
    );
    if (!player || player.teamId !== state.userTeamId || !issue) return null;
    /** 라커룸에서 선 자리 — 같은 불만이라도 주장이 들고 온 것은 다른 자리다 */
    const seat = leaderRoleOf(state, player);
    return {
      channel: "player",
      speakerId: player.name,
      about: player.id,
      contextCard: {
        code: "grievance",
        reason: issue.reason,
        ...(seat ? { leader: seat } : {}),
        value: issueDays(state, issue),
      },
      facts: playerFacts(state, player, issue, row.topic, sharp),
    };
  }

  if (channel === "captain") {
    const squad = userPlayers(state);
    const captain = squad.find((p) => p.isCaptain);
    const form = firstTeamForm(state);
    // 주장이 없으면 라커룸을 대신할 사람도 없다 — 코어가 화자를 지어내지 않는다
    if (!captain || form === null) return null;
    /**
     * **폼이 둘 실린다** — 1군 평균과 리더 그룹 평균 (people.md §5-1). 라커룸이
     * 통째로 식은 것과 리더들만 처진 것은 감독이 손댈 자리가 다르다.
     */
    const leaders = leaderGroupOf(state, state.userTeamId);
    const leaderForm =
      leaders.length === 0
        ? null
        : leaders.reduce(
            (sum, row) => sum + (squad.find((p) => p.id === row.playerId)?.state.form ?? 0),
            0,
          ) / leaders.length;
    const facts: PressFact[] = [
      {
        kind: "morale",
        data: {
          tags: leaderForm === null ? [formLabel(form)] : [formLabel(form), formLabel(leaderForm)],
        },
        about: null,
        sharp,
      },
    ];
    const recent = recentOutcomes(state, state.userTeamId, APPROACH_WINLESS_WINDOW);
    if (recent.length > 0 && recent.every((r) => r !== "win")) {
      facts.push({
        kind: "winless",
        data: { values: { matches: recent.length }, tags: [...recent] },
        about: null,
        sharp: true,
      });
    }
    // 떠난 선수의 불만을 주장이 세지 않는다 — 은퇴가 줄을 지우지 않는다 (people.md §5)
    const unhappy = state.issues.filter((i) => squad.some((p) => p.id === i.gamePlayerId)).length;
    if (unhappy > 0) {
      facts.push({
        kind: "unhappy",
        data: { values: { count: unhappy }, tags: ["count"] },
        about: null,
        sharp: false,
      });
    }
    return {
      channel,
      speakerId: captain.name,
      about: null,
      contextCard: { code: "dressing-room-form", value: form },
      formLabel: formLabel(form),
      facts,
    };
  }

  return null;
}

// ── 하루 ───────────────────────────────────────────────────────

export function tickApproaches(state: GameState, digest: TickSink): boolean {
  if (expireApproach(state, digest)) return false;
  return openSeasonReview(state, digest);
}

function openSeasonReview(state: GameState, digest: TickSink): boolean {
  if (managedTeamId(state) === null) return false;
  const since = diffDays(state.calendar.preseasonStart, state.date);
  if (since < 0 || since >= REVIEW_WINDOW_DAYS) return false;
  const record = state.seasonRecords[state.seasonRecords.length - 1];
  if (!record || record.season !== state.season - 1 || record.teamId !== state.userTeamId) {
    return false;
  }
  const opened = state.approaches;
  // 시즌당 한 번 — 창이 이레라 답한 뒤에도 같은 시즌에 다시 서지 않는다
  const id = `approach-season-review-${state.season}`;
  if (opened.some((a) => a.id === id)) return false;

  // ── 소음의 문 넷 — `openApproach`의 것과 같은 자다 (people.md §8) ──
  if (pendingApproach(state)) return false;
  const press = pendingPress(state);
  if (press && diffDays(press.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  if (opened.some((a) => a.date === state.date)) return false;
  const owner = ownerOf(state);
  const facts: PressFact[] = [
    {
      kind: "season-verdict",
      data: { values: { season: record.season, rank: record.position } },
      about: null,
      sharp: true,
    },
    ...record.board.expectations.map((text) => ({
      kind: "board" as const,
      data: { text },
      about: null,
      sharp: false,
    })),
  ];
  if (record.board.assessment)
    facts.push({
      kind: "board",
      data: { text: record.board.assessment },
      about: null,
      sharp: false,
    });
  const contextCard: ApproachContext = {
    code: "season-review",
    value: record.position,
  };
  const approach: Approach = {
    id,
    date: state.date,
    channel: "owner",
    topic: "season-review",
    speakerId: owner.characterId,
    about: null,
    contextCard,
    facts,
    // 압력 줄을 세우지 않으므로 계단은 오르지 않는다 — 폭만 정하는 고정값이다
    status: "pending",
  };
  pushApproach(state, approach);
  const line = approachContextText(contextCard);
  const speaker = `${owner.characterId}(${APPROACH_CHANNEL_LABEL.owner})`;
  digest.push(`${josa(speaker, "이/가")} 감독을 찾아왔다 — ${line}`);
  // 계단 2 — 다른 자리가 같은 계단에서 남기는 눈금과 같다
  pushNarrative(state, `${owner.characterId} 면담 요청 (${line})`, 3);
  return true;
}

export function respondToApproach(
  state: GameState,
  input: {
    resolveIssues?: readonly {
      playerId: string;
      reason: import("@story-fm/domain").PlayerIssueReason;
    }[];
    reaction?: ReactionInput;
    decline?: boolean;
    /**
     * 감독이 이 자리에서 한 약속 — **당사자에게만이다** (people.md §5-2).
     * 주장·구단주가 온 자리에는 약속을 걸 사람이 없다.
     */
    promise?: PromiseInput;
    /** 잔향 — 찾아온 당사자에게 남는 심경 한 문장. 주장·구단주 자리에는 버린다 */
    mood?: MoodLine;
  },
): CommandResult {
  const approach = pendingApproach(state);
  if (!approach) return { ok: false, message: "지금 답할 자리가 없습니다" };
  /**
   * **거절은 감독이 거절했을 때만이다.** 둘 다 비운 호출을 거절로 읽으면 감독이 하지
   * 않은 결정이 장부에 남는다 — 모델이 다시 부르게 하는 편이 낫다 (press.ts와 같은 결).
   */
  if (input.decline !== true && !input.reaction) {
    return { ok: false, message: "답변에는 reaction이 필요합니다" };
  }
  const parsed = ReactionSchema.safeParse(input.reaction ?? { reason: "면담 거절" });
  if (!parsed.success) return { ok: false, message: "유효한 면담 반응이 필요합니다" };
  const resolutions = (input.resolveIssues ?? []).map((request) => {
    const pick = pickOurPlayer(state, request.playerId);
    return { ...request, playerId: pick.ok ? pick.player.id : request.playerId };
  });
  if (
    resolutions.some(
      (r) =>
        input.decline ||
        r.playerId !== approach.about ||
        !state.issues.some((i) => i.gamePlayerId === r.playerId && i.reason === r.reason),
    )
  )
    return { ok: false, message: "현재 면담 당사자의 불만만 해소할 수 있습니다" };
  const effect = closeApproach(state, approach, parsed.data);
  approach.status = input.decline ? "declined" : "answered";
  state.issues = state.issues.filter(
    (i) => !resolutions.some((r) => r.playerId === i.gamePlayerId && r.reason === i.reason),
  );

  /**
   * ── 약속은 **답을 닫은 뒤에** 장부에 선다 ── (people.md §5-2)
   *
   * **채널이 가른다** — 선수 본인의 자리에서만 열린다. 주장·구단주 자리에는 약속을
   * 걸 사람이 없다. 갈래가 대상에 맞는지는 `openPromise`가 다시 본다.
   */
  const inTheRoom = approach.channel === "player";
  if (input.mood && inTheRoom && approach.about) {
    applyMoodNotes(state, [{ ...input.mood, playerId: approach.about }], new Set([approach.about]));
  }
  // 다가옴의 스탠스는 판정이 아니라 자르지 않는다 — 그 자리에는 사실 줄만 선다 (career.md §2)

  const promised = input.promise
    ? promisePiece(
        inTheRoom && approach.about
          ? openPromise(
              state,
              approach.about,
              input.promise.kind,
              input.promise.days,
              input.promise.number,
            )
          : { ok: false, message: "약속은 당사자에게만 할 수 있습니다" },
      )
    : null;

  const label = input.decline ? "돌려보냄" : parsed.data.reason;
  pushNarrative(
    state,
    `${approach.speakerId} 면담 (${contextTextOf(state, approach)} · ${label})`,
    3,
  );
  /**
   * 찾아온 사람과 마주 앉은 것이 그 사람에게 걸린 실마리를 닫는다 (career.md §1).
   * 화자는 인물의 `characterId`이고 `about`은 선수의 id라 — 실마리가 어느 쪽으로
   * 걸렸든 같은 자리에서 닫힌다. 구단주 자리는 걸린 사람 없는 보드 실마리도 닫는다.
   */
  const net = effect.board + effect.squad + effect.team + effect.target;
  return {
    ok: true,
    tone: net >= 0 ? ("good" as const) : ("bad" as const),
    message: `${approach.speakerId} 응대(${label})${effectSuffix(effect)}${promised ? promised.text : ""}`,
    brief: {
      head: `${approach.speakerId} 응대(${label})`,
      items: [
        ...deltaItems([
          ["보드", effect.board],
          ["선수단", effect.squad],
          effect.targetName ? [`${effect.targetName} 사기`, effect.target] : null,
          ["팀 사기", effect.team],
        ]),
        ...(promised ? [promised.item] : []),
      ],
    },
  };
}

/** 서사 사건과 면담 요청을 같은 검증 경계에서 처리한다. */
export function recordStoryIncident(
  state: GameState,
  input: Parameters<typeof recordIncident>[1] & {
    approach?: { topic: ApproachTopic; playerId?: string };
  },
): CommandResult {
  let scene: Scene | null = null;
  const request = input.approach;
  if (request) {
    if (
      managedTeamId(state) === null ||
      pendingApproach(state) ||
      state.approaches.some((a) => a.date === state.date)
    )
      return { ok: false, message: "면담은 재직 중 하루 한 자리만 열 수 있습니다" };
    const press = pendingPress(state);
    if (press && diffDays(press.date, state.date) < APPROACH_PATIENCE_DAYS)
      return { ok: false, message: "현재 열린 회견에 먼저 답해야 합니다" };
    if (request.topic === "season-review")
      return { ok: false, message: "시즌 리뷰는 시즌 원장이 엽니다" };
    const pick = request.playerId ? pickOurPlayer(state, request.playerId) : null;
    if (request.topic !== "morale" && (!pick || !pick.ok))
      return { ok: false, message: "면담의 당사자는 현재 우리 선수여야 합니다" };
    scene = sceneFor(state, {
      topic: request.topic,
      subject: pick?.ok ? pick.player.id : SQUAD_SUBJECT,
    });
    if (!scene) return { ok: false, message: "선택한 면담을 뒷받침하는 현재 사실이 없습니다" };
  }
  const result = recordIncident(state, input);
  if (!result.ok || !scene || !request) return result;
  pushApproach(state, {
    id: `approach-${request.topic}-${scene.about ?? "squad"}-${state.date}`,
    date: state.date,
    channel: scene.channel,
    topic: request.topic,
    speakerId: scene.speakerId,
    about: scene.about,
    contextCard: scene.contextCard,
    facts: scene.facts,
    status: "pending",
  });
  return { ...result, message: `${result.message} · ${scene.speakerId} 면담 요청` };
}
