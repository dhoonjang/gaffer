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
  type Negotiation,
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
  teamNameIn,
  transferRequestOf,
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

export function renewalOpenFor(state: GameState, playerId: string): boolean {
  // 앉기만 한 자리는 압력을 멈추지 못한다 — 오퍼가 실려야 협상이다 (transfer.md §12-2)
  return state.negotiations.some(
    (n) =>
      n.gamePlayerId === playerId &&
      n.kind === "renew" &&
      n.status === "open" &&
      n.rounds.length > 0,
  );
}

/** 그 협상이 끝난 날 — 만료는 기한이, 거절은 마지막 라운드가 그날이다 */
function closedOn(negotiation: Negotiation): string {
  if (negotiation.status === "expired") return negotiation.expiresOn;
  return negotiation.rounds[negotiation.rounds.length - 1]?.date ?? negotiation.openedOn;
}

/** 그 협상에 오른 가장 큰 값 — 관심의 크기는 부른 값으로 잰다 */
export function topFeeOf(negotiation: Negotiation): number {
  return Math.max(0, ...negotiation.rounds.map((r) => r.fee));
}

/**
 * 최근 창에서 끝난 매각 오퍼 — **선수별로 한 번에 묶는다.**
 *
 * 선수마다 협상 장부를 훑으면 시즌이 쌓일수록 tick이 스쿼드 × 협상 전체가 된다.
 * 협상 장부는 지워지지 않으므로(transfer.md §1) 그 곱은 계속 자란다.
 */
export function recentSellOffers(state: GameState): Map<string, Negotiation[]> {
  const byPlayer = new Map<string, Negotiation[]>();
  for (const n of state.negotiations) {
    if (n.kind !== "sell") continue;
    if (n.status !== "rejected" && n.status !== "expired") continue;
    if (diffDays(closedOn(n), state.date) > INTEREST_WINDOW_DAYS) continue;
    const rows = byPlayer.get(n.gamePlayerId);
    if (rows) rows.push(n);
    else byPlayer.set(n.gamePlayerId, [n]);
  }
  return byPlayer;
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
 * **요청이 서 있는 선수의 자리에는 그 요청이 맨 앞에 선다** (people.md §8). 그 자리에서
 * 한 답이 요청의 답이 되므로(`respondToApproach`), 그가 아는 가장 큰 사실이 빠진 채로
 * 답을 받을 수는 없다. 꼭대기 계단의 자리는 이미 들고 있다 — 두 번 세우지 않는다.
 */
export function withStandingRequest(state: GameState, scene: Scene | null): Scene | null {
  if (!scene || scene.about === null) return scene;
  if (scene.channel !== "player" && scene.channel !== "agent") return scene;
  if (scene.facts.some((f) => f.kind === "transfer-request")) return scene;
  const request = transferRequestOf(state, scene.about);
  if (!request || request.answeredOn !== undefined) return scene;
  const player = playerById(state, scene.about);
  if (!player) return scene;
  const fact: PressFact = {
    kind: "transfer-request",
    data: {
      name: player.name,
      values: { days: diffDays(request.since, state.date) },
      tags: [request.reason],
    },
    about: player.id,
    sharp: true,
  };
  return { ...scene, facts: [fact, ...scene.facts] };
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
    teamId?: string;
    contextCard: ApproachContext;
  },
): string {
  /**
   * 자리의 주인 — 대개는 선수지만 **면접에서는 구단**이다 (career.md §5.1). 어느
   * 쪽이든 이름은 코어만 아는 것이라 여기서 채운다.
   */
  const subject =
    a.teamId !== undefined
      ? teamNameIn(state, a.teamId)
      : a.about === null
        ? undefined
        : (playerById(state, a.about)?.name ?? undefined);
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
  /**
   * **면접은 아무 축도 옮기지 않는다** (career.md §5.1) — 감독은 아직 그 구단의
   * 사람이 아니라 옮길 보드 평판이 없다. 이 답이 남기는 것은 제안이거나 닫힌 문이다.
   *
   * ⚠️ 스탠스 표를 태우고 폭을 0으로 두지 않는다 — 우리 구단주의 축이 걸린 표라,
   * 폭 하나가 잘못 서면 남의 집 면접이 우리 보드 평판을 옮긴다.
   */
  if (approach.topic === "interview") return NO_EFFECT;
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

/**
 * 타 구단의 관심이 **아직 뜨거운 창** — 이 안에 끝난 오퍼만 에이전트가 들고 온다
 * (people.md §8). 창이 지나면 원인이 사라져 하루 12씩 식는다 — 답으로 지울 것이
 * 없는 주제라 식는 것이 유일한 끝이다.
 */
export const INTEREST_WINDOW_DAYS = 14;

export const SQUAD_SUBJECT = "squad";

const BOARD_SUBJECT = "board";

export const CHANNEL_OF: Record<ApproachTopic, ApproachChannel> = {
  minutes: "player",
  "losing-run": "player",
  "early-return": "player",
  demotion: "player",
  listed: "player",
  "blocked-move": "player",
  "out-of-position": "player",
  promise: "player",
  number: "player",
  overload: "player",
  contract: "agent",
  interest: "agent",
  morale: "captain",
  "season-review": "owner",
  // 마주 앉은 것은 **그 구단의** 구단주다 — 자리는 `Approach.teamId`가 가리킨다
  interview: "owner",
};

/** 최근 창에서 식은 타 구단의 관심 — 그 사람의 에이전트가 아는 사실 */
export interface Interest {
  offers: number;
  topFee: number;
  buyerName: string;
}

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

// ── 응답 ───────────────────────────────────────────────────────

/** 아무것도 옮기지 않은 자리 — 면접이 여기로 떨어진다 (career.md §5.1) */
export const NO_EFFECT: SocialEffect = {
  board: 0,
  media: 0,
  squad: 0,
  target: 0,
  targetName: null,
  team: 0,
};

export function subjectOf(approach: Approach): string {
  // 에이전트는 대리로 왔을 뿐이라 압력 줄은 그가 대리한 선수의 것이다
  if (approach.channel === "player" || approach.channel === "agent") return approach.about ?? "";
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
