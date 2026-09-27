import { type GameState, userPlayers, pushNarrative } from "../../../../common/core/state";
import {
  type TalkInput,
  SHOUT_PER_MATCH,
  matchSquadIds,
  SHOUT_MORALE_BOUND,
  TALK_MORALE_BOUND,
  ROOM_MORALE_BOUND,
  roundAwayFromZero,
  creditTalkMorale,
  resolveMoods,
  promisePiece,
  OCCASION_KO,
} from "../../../../story/commands/talk";
import { type CommandResult } from "../../../../common/commands/result";
import { ReactionSchema, type GamePlayer } from "@story-fm/domain";
import { pickOurPlayer } from "../../../../common/core/player-ref";
import { clampForm, moraleToForm } from "../../../../common/players/form";
import { signed, item, briefNames } from "../../../../common/commands/brief";
import { applyMoodNotes, TEAM_TALK_MOODS } from "../../../../common/players/mood-notes";
import { settlingAnchor, creditSettling, settlingOf } from "../../../../common/players/settling";
import { openPromise } from "../../../../negotiation/players/promises";

/**
 * **감독의 말 하나** — 팀토크와 면담이 같은 함수를 지난다 (career.md §2).
 *
 * 판정은 **대화가 마무리된 턴에 한 번** 선다. 그 판단은 도구 설명과 경기 중 해석기의
 * 대화 절이 함께 들고(prompts.md §2), 여기서는 그것이 이미 끝난 것으로 본다.
 *
 * ⚠️ **날짜 게이트가 없다.** 하루에 몇 번이든 대화가 끝날 때마다 판정이 서고, 되풀이는
 * 듣는 선수마다의 **사기 합계 상한**(`creditTalkMorale`)이 자른다.
 */
export function applyTalk(state: GameState, input: TalkInput): CommandResult {
  const parsed = ReactionSchema.safeParse(input.reaction);
  if (!parsed.success) return { ok: false, message: "대화에는 -1~1의 반응과 근거가 필요합니다" };
  const shout = input.occasion === "shout";
  /**
   * **외침을 세는 것은 하루가 아니라 경기다** (career.md §2). 라커룸 밖의 말이라
   * 경기당 셋이고, 그 뒤로는 남은 말이 라커룸의 몫이다.
   */
  if (shout) {
    const pending = state.pendingMatch;
    // 벤치가 없으면 외칠 자리도 없다 — 라커룸의 한마디는 pre·half·post·daily다
    if (!pending) {
      return { ok: false, message: "외침은 경기 중 정지점에서만 나옵니다" };
    }
    const used = pending.shouts;
    if (used >= SHOUT_PER_MATCH) {
      return {
        ok: true,
        message: `이번 경기의 외침 ${SHOUT_PER_MATCH}번을 다 썼습니다 — 남은 말은 라커룸의 몫입니다`,
      };
    }
  }

  const present = matchSquadIds(state);
  /**
   * **대상은 인자가 정한다** — 이름을 적으면 그 사람들, 비우면 선수단 전체다.
   * 외침만은 **그 경기의 명단**으로 한 번 더 좁힌다: 벤치에서 그라운드로 가는 말이라
   * 집에 있는 선수단까지 울릴 수 없다.
   */
  const squad = userPlayers(state);
  const named: GamePlayer[] = [];
  const unresolved: string[] = [];
  for (const ref of input.players ?? []) {
    const pick = pickOurPlayer(state, ref);
    if (pick.ok) {
      if (!named.some((p) => p.id === pick.player.id)) named.push(pick.player);
    } else unresolved.push(ref);
  }
  /**
   * **빈 배열은 이름을 부르지 않은 것과 같다** — 모델이 `players: []`로 보내는 것은
   * "아무에게도"가 아니라 "특정한 누구도 아닌", 곧 선수단 전체다. 여기서 가르지 않으면
   * 그 호출이 아무에게도 닿지 않는 말이 되어 조용히 사라진다.
   */
  const toEveryone = (input.players?.length ?? 0) === 0;
  if (!toEveryone && named.length === 0) {
    return { ok: false, message: `그 이름을 찾지 못했습니다 — ${unresolved.join(" · ")}` };
  }
  const addressed = toEveryone ? squad : named;
  const heard = shout && present ? addressed.filter((p) => present.has(p.id)) : addressed;
  if (heard.length === 0) {
    return { ok: true, message: "그 말을 들은 선수가 없습니다 — 명단에 없는 이름입니다" };
  }
  const issueTargets = (input.resolveIssues ?? []).map((request) => {
    const pick = pickOurPlayer(state, request.playerId);
    return { ...request, playerId: pick.ok ? pick.player.id : request.playerId };
  });
  if (
    issueTargets.some(
      (request) =>
        toEveryone ||
        !heard.some((p) => p.id === request.playerId) ||
        !state.issues.some(
          (i) => i.gamePlayerId === request.playerId && i.reason === request.reason,
        ),
    )
  ) {
    return { ok: false, message: "불만 해소는 대화에서 지목한 선수의 현재 불만만 가능합니다" };
  }
  if (shout && state.pendingMatch) state.pendingMatch.shouts += 1;
  const alone = heard.length === 1;
  const base = alone ? (parsed.data.target ?? 0) : (parsed.data.team ?? 0);
  const bound = shout ? SHOUT_MORALE_BOUND : alone ? TALK_MORALE_BOUND : ROOM_MORALE_BOUND;
  const scale = bound;

  /** 실제로 남은 사기 — 상한에 걸린 사람은 0이다 */
  const applied = new Map<string, number>();
  for (const p of heard) {
    const raw = roundAwayFromZero(base * scale);
    const bounded = Math.max(-bound, Math.min(bound, raw));
    const landed = creditTalkMorale(state, p, bounded);
    if (landed !== 0) p.state.form = clampForm(p.state.form + moraleToForm(landed));
    applied.set(p.id, landed);
  }
  const landed = [...applied.values()].filter((v) => v !== 0);
  const moved = landed.length;
  const low = moved > 0 ? Math.min(...landed) : 0;
  const high = moved > 0 ? Math.max(...landed) : 0;
  /** 감독이 읽는 한 줄 — 전원이 같은 값이면 한 수, 갈리면 폭이다 */
  const moraleText =
    moved === 0 ? "0" : low === high ? signed(low) : `${signed(low)}~${signed(high)}`;

  const relieved = heard.filter((p) => issueTargets.some((i) => i.playerId === p.id));
  state.issues = state.issues.filter(
    (issue) =>
      !issueTargets.some((r) => r.playerId === issue.gamePlayerId && r.reason === issue.reason),
  );

  /**
   * 잔향은 **불만이 풀린 뒤에** 선다 — 앞에 두면 방금 푼 불만을 안으라고 요구해
   * 잘 풀린 대화의 문장이 버려진다 (`applyMoodNotes`의 세 번째 문).
   * 그 말을 들은 선수에게만, 셋까지 — 넘치면 앞의 셋이다.
   */
  applyMoodNotes(
    state,
    resolveMoods(state, (input.moods ?? []).slice(0, TEAM_TALK_MOODS)),
    new Set(heard.map((p) => p.id)),
  );

  /**
   * **정착 크레딧의 앵커는 대상 수가 가른다** (player.md §9.3) — 마주 앉아 들은 말이
   * `talk`(5±4), 라커룸 앞에서 이름이 불린 것이 `team_talk`(1.5±1.5)다.
   *
   * ⚠️ **사기가 움직이지 않은 대화(`neutral`)에는 방향이 없다** — 크레딧도 0이다.
   * 부호로 방향을 가르면 0이 음수 쪽에 떨어져, 나쁘지도 않았던 대화가 적응을 뒤로
   * 민다. 외침에는 크레딧이 아예 없다 — 새 영입을 라커룸으로 끌어들이는 것은 마주
   * 앉아 한 말의 몫이지 90분 사이에 던진 한마디가 아니다.
   */
  const settlingKind = alone ? ("talk" as const) : ("team_talk" as const);
  const settlingAnchorValue = settlingAnchor(settlingKind, {
    direction: base > 0 ? 1 : -1,
    intensity: Math.abs(base) * 2,
  });
  const settled =
    base === 0 || shout
      ? []
      : heard.filter(
          (p) =>
            creditSettling(state, p.id, settlingKind, {
              anchor: settlingAnchorValue,
              ...(input.settling === undefined ? {} : { proposed: input.settling }),
              ...(input.settlingNote === undefined ? {} : { note: input.settlingNote }),
            }) !== 0,
        );
  const settling = alone && settled.length > 0 ? settlingOf(state, heard[0]!.id) : null;

  /**
   * ── 약속은 **판정이 끝난 뒤에** 장부에 선다 ── (career.md §2 · people.md §5-2)
   *
   * **상대가 한 명일 때만 받는다** — 여럿에게 동시에 한 약속은 누가 그 약속의 주인인지
   * 장부가 가리지 못한다.
   *
   * ⚠️ 순서가 뒤집히면 방금 연 약속이 대화의 불만 해소에 쓸려 나갈 여지가 생긴다.
   * 지금 지우는 것은 `state.issues`뿐이라 실제로는 닿지 않지만, 그 안전이 지워지는
   * 자리와 열리는 자리의 **간격**에 기대고 있으므로 순서를 명시적으로 둔다.
   */
  const promised = !input.promise
    ? null
    : alone
      ? promisePiece(
          openPromise(
            state,
            heard[0]!.id,
            input.promise.kind,
            input.promise.days,
            input.promise.number,
            input.promise.position,
          ),
        )
      : {
          text: " · 약속 반려 — 여럿에게 한 약속은 장부에 서지 않습니다",
          item: item({ label: "약속", text: "반려", note: "상대가 한 명일 때만" }),
        };

  /** 감독이 읽는 대상 이름 — 전원이면 「팀」, 아니면 부른 이름들 */
  const whoKo = toEveryone
    ? shout
      ? "명단"
      : "팀"
    : alone
      ? heard[0]!.name
      : briefNames(heard.map((p) => p.name));
  const used = state.pendingMatch?.shouts ?? 0;
  pushNarrative(
    state,
    `${shout ? "외침" : "대화"}(${parsed.data.reason}) — ${whoKo} 사기 ${moraleText}`,
    // 하루 한 번의 라커룸 장면과 90분 사이의 한마디가 같은 무게로 남지는 않는다
    shout ? 1 : 2,
  );
  const capped = moved < heard.length;
  const moraleLabel = toEveryone ? (shout ? "명단" : "팀") : alone ? "" : `${heard.length}명`;
  return {
    ok: true,
    /**
     * 펼치지 않아도 잘 풀렸는지는 알아야 한다 — 숫자는 펼쳤을 때만.
     * 결은 **그 말이 어떻게 닿았는가**이지 합계 상한이 얼마를 통과시켰는가가 아니다.
     */
    tone: base >= 0 ? ("good" as const) : ("bad" as const),
    message:
      `${whoKo} 사기 ${moraleText}` +
      (capped ? ` · ${heard.length - moved}명은 대화 사기 상한에 닿아 그대로입니다` : "") +
      (relieved.length > 0 ? ` · 불만 해소 ${briefNames(relieved.map((p) => p.name))}` : "") +
      (shout ? ` · 이번 경기 외침 ${used}/${SHOUT_PER_MATCH}` : "") +
      (settling ? ` · 적응 ${Math.round(settling.progress * 100)}%` : "") +
      (!settling && settled.length > 0
        ? ` · 적응 중인 ${settled.length}명이 한 걸음 가까워졌습니다`
        : "") +
      (promised ? promised.text : "") +
      (unresolved.length > 0 ? ` · 찾지 못한 이름 ${unresolved.join(" · ")}` : ""),
    /**
     * 사기 변화는 **항목 하나**다 — 부호는 `delta`가 나르고 화면이 색을 준다.
     * 감독이 무슨 말을 어떻게 했는지는 장면의 것이지 알림의 것이 아니다.
     */
    brief: {
      head: shout
        ? "정지점 외침"
        : toEveryone
          ? `${OCCASION_KO[input.occasion]} 팀토크`
          : alone
            ? `${heard[0]!.name} 대화`
            : `${heard.length}명 대화`,
      items: [
        /**
         * 항목의 이름은 **몇 명이 들었는가**다 — 누가 들었는지는 머리가 든다.
         * 이름을 여기까지 실으면 항목 한 줄이 이름으로 채워져 숫자가 밀린다.
         */
        ...(low === high
          ? [
              item({
                label: moraleLabel ? `${moraleLabel} 사기` : "사기",
                text: moraleText,
                delta: low,
              }),
            ]
          : [item({ label: moraleLabel ? `${moraleLabel} 사기` : "사기", text: moraleText })]),
        ...(capped ? [item({ label: "상한", text: `${heard.length - moved}명` })] : []),
        ...(relieved.length > 0
          ? [item({ text: "불만 해소", note: briefNames(relieved.map((p) => p.name)) })]
          : []),
        // 몇 번 남았는지는 감독이 아껴 쓸지 정하는 값이다 — 안내 문구가 아니라 눈금
        ...(shout ? [item({ label: "외침", text: `${used}/${SHOUT_PER_MATCH}` })] : []),
        ...(settling
          ? [item({ label: "적응", text: `${Math.round(settling.progress * 100)}%` })]
          : settled.length > 0
            ? [item({ label: "적응", text: `${settled.length}명` })]
            : []),
        ...(promised ? [promised.item] : []),
      ],
    },
  };
}
