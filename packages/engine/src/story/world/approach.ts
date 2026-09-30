import {
  type Approach,
  APPROACH_AXES,
  APPROACH_CHANNEL_LABEL,
  APPROACH_PATIENCE_DAYS,
  type ApproachChannel,
  type ApproachContext,
  approachContextText,
  type ApproachTopic,
  type ManagerPromise,
  type PlayerIssue,
  type PressFact,
  pressFactText,
  type ReactionInput,
  type TickSink,
} from "@story-fm/domain";
import { diffDays } from "../../common/core/dates";
import {
  type GameState,
  pendingApproach,
  playerById,
  pushNarrative,
  squadLevelOf,
  userPlayers,
} from "../../common/core/state";
import { formLabel } from "../../common/players/form";
import { signed } from "./press";
import { applySocialReaction, type SocialEffect } from "./social";

/** 1군 평균 폼 — 라커룸의 온도. 2군은 감독의 일상에 닿지 않아 세지 않는다 */
export function firstTeamForm(state: GameState): number | null {
  const squad = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (squad.length === 0) return null;
  return squad.reduce((sum, p) => sum + p.state.form, 0) / squad.length;
}

/**
 * 그 선수의 **마지막으로 깨진 약속** — `promise` 불만을 세운 줄이다 (people.md §5-2).
 *
 * 판정이 끝난 약속은 장부에 이력으로 남으므로 뒤쪽 줄일수록 최근이다. 여러 줄이
 * 깨져 있어도 불만은 하나라, 그 자리가 말하는 것도 하나다.
 */
export function lastBrokenPromise(state: GameState, playerId: string): ManagerPromise | null {
  const rows = state.promises.filter((p) => p.gamePlayerId === playerId && p.status === "broken");
  return rows.reduce<ManagerPromise | null>(
    (latest, row) => (latest === null || row.dueOn >= latest.dueOn ? row : latest),
    null,
  );
}

/**
 * 자리의 배경 한 줄 — **카드에서 만든다** (people.md §8).
 *
 * 이름과 폼 라벨은 코어만 아는 것이라 여기서 채워 넘긴다.
 */
export function contextTextOf(
  state: GameState,
  a: {
    about: string | null;
    contextCard: ApproachContext;
  },
): string {
  // 자리의 주인 이름은 코어만 아는 것이라 여기서 채운다
  const subject = a.about === null ? undefined : (playerById(state, a.about)?.name ?? undefined);
  const form = a.contextCard.code === "dressing-room-form" ? firstTeamForm(state) : null;
  return approachContextText(a.contextCard, {
    ...(subject ? { subject } : {}),
    ...(form === null ? {} : { form: formLabel(form) }),
  });
}

/** 사흘 동안 답이 없으면 감독이 지나친 것이다 — 거절과 같은 값을 치른다 */
export function expireApproach(state: GameState, digest: TickSink): boolean {
  const open = pendingApproach(state);
  if (!open || diffDays(open.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  const effect = closeApproach(state, open, null);
  open.status = "declined";
  const line = contextTextOf(state, open);
  digest.push(`${line} — 감독이 답하지 않았다${effectSuffix(effect)}`);
  pushNarrative(state, `${line} (응답 없음)`, 3);
  return true;
}

/**
 * 자리를 닫고 값을 치른다 — `stance`가 `null`이면 답하지 않은 것이다.
 *
 * ⚠️ 이 함수는 `status`를 건드리지 않는다 — 라벨은 부르는 쪽이 정한다(방치와 거절이
 * 같은 값을 치르되 장부에 남는 이름은 다를 수 있다). `press.ts`의 `applyPressOutcome`과
 * 같은 규약이다.
 */
export function closeApproach(
  state: GameState,
  approach: Approach,
  reaction: ReactionInput | null,
): SocialEffect {
  const effect = applySocialReaction(state, {
    reaction: reaction ?? { reason: "면담을 지나침" },
    band: APPROACH_BAND,
    targetPlayerId: approach.about,
    axes: APPROACH_AXES[approach.channel],
  });

  return effect;
}

/**
 * 스냅샷 블록 — 답을 기다리는 자리가 있을 때만 (매 턴 정가로 읽히는 블록이다).
 *
 * **대사가 아니라 사실을 넘긴다.** 화자를 이름으로 지목하되 그가 무슨 말을 어떻게
 * 꺼내는지는 GM이 쓴다 (overview.md §1 철칙 4 · `describePendingPress`와 같은 결).
 */
export function describePendingApproach(state: GameState): string | null {
  const a = pendingApproach(state);
  if (!a) return null;
  const waited = diffDays(a.date, state.date);
  return [
    `${a.speakerId}(${APPROACH_CHANNEL_LABEL[a.channel]}) · ${contextTextOf(state, a)}` +
      (waited > 0 ? ` · ${waited}일째 기다린다` : ""),
    `그가 아는 사실 (이 밖은 말하지 못한다):`,
    ...a.facts.map(
      (f) => `- ${pressFactText(f)}${f.about ? ` [${f.about}]` : ""}${f.sharp ? " ⚡" : ""}`,
    ),
  ].join("\n");
}

/**
 * 이 자리 하나가 옮길 수 있는 축별 최대 폭.
 * 회견(`PRESS_BAND` 4)보다 좁은 이유는 자리가 좁기 때문이다 — 마이크 앞에서 한 말이
 * 복도에서 한 말보다 멀리 간다.
 */
export const APPROACH_BAND = 3;

/**
 * 시즌 리뷰 면담이 설 수 있는 창 — **프리시즌 시작일부터 이 날 수 안의 첫 하루**
 * (career.md §5). 창 안에 소음의 문이 한 번도 열리지 않으면 그 시즌 면담은 없다.
 */
export const REVIEW_WINDOW_DAYS = 7;

/** 무승 계단을 재는 창 — 회견과 같은 자를 쓴다 */
export const APPROACH_WINLESS_WINDOW = 4;

export const SQUAD_SUBJECT = "squad";

const BOARD_SUBJECT = "board";

export const CHANNEL_OF: Record<ApproachTopic, ApproachChannel> = {
  minutes: "player",
  "losing-run": "player",
  "early-return": "player",
  demotion: "player",
  "out-of-position": "player",
  promise: "player",
  number: "player",
  overload: "player",
  morale: "captain",
  "season-review": "owner",
};

// ── 사실 카드 ──────────────────────────────────────────────────

/** 이 자리를 여는 재료 — 화자와 그가 아는 사실. 세울 수 없으면 `null` */
export interface Scene {
  channel: ApproachChannel;
  speakerId: string;
  about: string | null;
  /** 한 줄 배경의 **카드** — 문장은 `approachContextText`가 만든다 */
  contextCard: ApproachContext;
  /** 폼 라벨처럼 코어만 아는 이름 — 카드에 적지 않고 문장을 만들 때만 쓴다 */
  formLabel?: string;
  facts: PressFact[];
}

/** 불만이 걸린 날부터 오늘까지 */
export function issueDays(state: GameState, issue: PlayerIssue): number {
  return diffDays(issue.since, state.date);
}

export function subjectOf(approach: Approach): string {
  if (approach.channel === "player") return approach.about ?? "";
  return approach.channel === "captain" ? SQUAD_SUBJECT : BOARD_SUBJECT;
}

/** 움직인 값들을 사실 줄로 — 0인 축은 쓰지 않는다 */
export function effectSuffix(effect: SocialEffect): string {
  const parts = [
    signed("보드", effect.board),
    signed("선수단", effect.squad),
    effect.targetName ? signed(`${effect.targetName} 사기`, effect.target) : null,
    signed("팀 사기", effect.team),
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}
