import { type GameState, playerById, pushNarrative } from "../../../../common/core/state";
import {
  type DelegateInput,
  limitOf,
  clubDirector,
  kindKo,
  unavailable,
  openFor,
  statusAfter,
  standingDemand,
  overLimit,
  adoptByPolicy,
  openByPolicy,
} from "../../../../negotiation/market/mandate";
import { type CommandResult } from "../../../../common/commands/result";
import {
  type NegotiationKind,
  type Delegation,
  josaOf,
  mandateLimitText,
  type Negotiation,
  type TickSink,
  pushEvent,
  isPlayerDeal,
  isMandated,
} from "@story-fm/domain";
import { pickAnyPlayer } from "../../../../common/core/player-ref";
import {
  openNegotiationFor,
  negotiationKindKo,
  incomingOffer,
  answerIncomingOffer,
} from "../../../../negotiation/market/negotiation";
import { acceptDeal } from "./negotiation";
import { settleDueResponse } from "../../../../negotiation/market/counterparty";

/**
 * 협상을 단장에게 맡긴다 — 이름을 부르면 그 건 하나, 비우면 그 갈래의 방침이다.
 * `team_talk`이 대상을 비우면 선수단 전체인 것과 같은 규약이다 (prompts.md §2).
 */
export function delegateNegotiation(state: GameState, input: DelegateInput): CommandResult {
  const limit = limitOf(input);
  const director = clubDirector(state);
  if (input.playerId === undefined) {
    const kinds: NegotiationKind[] = input.kind
      ? [input.kind]
      : ["buy", "sell", "renew", "loan", "loan_out", "release"];
    const rest = state.delegations.filter((d) => !kinds.includes(d.kind));
    state.delegations = [
      ...rest,
      ...kinds.map((kind): Delegation => ({ kind, limit, since: state.date })),
    ];
    const label = kinds.length === 1 ? kindKo(kinds[0]!) : "이적·재계약";
    return {
      ok: true,
      message:
        `${label}${josaOf(label, "을/를")} ${director.name} 단장에게 맡겼습니다 — ` +
        `${mandateLimitText(limit, kinds[0]!)}. 앞으로 열리는 자리는 단장이 봅니다`,
    };
  }

  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const open = openNegotiationFor(state, player.id);
  const negotiation = open && (input.kind === undefined || open.kind === input.kind) ? open : null;
  let opened: string | null = null;
  let target = negotiation;
  if (target) {
    const blocked = unavailable(state, target, player.name);
    if (blocked) return { ok: false, message: blocked };
  } else {
    const kind = input.kind ?? (player.teamId === state.userTeamId ? "renew" : "buy");
    const first = openFor(state, player, kind, limit);
    if (!first.ok) return first;
    opened = first.message;
    target = openNegotiationFor(state, player.id);
    if (!target) return { ok: false, message: `${player.name} 협상이 열리지 않았습니다` };
  }
  target.mandate = limit;
  // 맡긴 자리에 답이나 조정이 이미 서 있으면 그 자리에서 한 번 굴린다
  const lines: string[] = [];
  runMandate(state, target, lines);
  return {
    ok: true,
    message:
      `${player.name} ${negotiationKindKo(target)} 협상을 ${director.name} 단장에게 맡겼습니다 — ` +
      `${mandateLimitText(limit, target.kind)}.` +
      (opened ? ` ${opened}` : "") +
      (lines.length > 0 ? ` ${lines.join(" ")}` : ""),
  };
}

/**
 * 맡긴 협상 하나를 오늘 굴린다 — tick과 맡기는 명령이 같은 문을 지난다.
 *
 * 순서가 뜻이다: 답할 날이 된 답을 앵커로 굳히고, 닫혔으면 결과를 알리고, 합의면 서명하고,
 * 서 있는 요구를 한도로 가르고, 아무것도 없으면 첫 제시를 넣는다.
 */
function runMandate(state: GameState, negotiation: Negotiation, digest: TickSink): void {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return;
  const director = clubDirector(state);
  const kindKoName = negotiationKindKo(negotiation);
  const say = (text: string): void =>
    pushEvent(
      digest,
      isPlayerDeal(negotiation.kind) ? "contract" : "interest",
      `${director.name} 단장 — ${text}`,
    );
  /** 단장이 더 할 수 없다 — 위임이 끝나고 협상은 감독에게 그냥 돌아온다 */
  const handOff = (why: string): void => {
    negotiation.mandate = null;
    say(`${player.name} ${kindKoName} 협상을 감독에게 돌립니다: ${why}`);
    // 오늘 답해야 하는 일의 눈금 — 답 도착과 같은 3이다 (people.md §9)
    pushNarrative(state, `${player.name} ${kindKoName} 위임이 감독에게 돌아옴 — ${why}`, 3);
  };

  /**
   * ① 답할 날이 된 답은 앵커로 굳는다 — 판정 호출이 없다.
   *
   * **감독이 나서지 않은 모든 협상이 지나는 그 문이다**(`settleDueResponse` — §12-1).
   * tick은 위임이 구르기 전에 이미 그 문을 한 번 지나므로, 여기 남는 것은 맡기는 그날
   * 답이 서 있던 자리다.
   */
  const settled = settleDueResponse(state, negotiation);
  if (settled && !settled.result.ok) return handOff(settled.result.message);

  // ② 닫힌 협상 — 결과를 알리고 위임을 접는다
  if (negotiation.status !== "open" && negotiation.status !== "agreed") {
    negotiation.mandate = null;
    say(
      negotiation.status === "completed"
        ? `${player.name} ${kindKoName}${josaOf(kindKoName, "을/를")} 매듭지었습니다`
        : negotiation.status === "rejected"
          ? `${player.name} ${kindKoName} 협상이 결렬됐습니다`
          : `${player.name} ${kindKoName} 협상이 기한을 넘겨 무산됐습니다`,
    );
    return;
  }

  // ③ 합의 — 단장이 서명한다. 소견이 붙은 검진은 감독의 결정이다
  if (negotiation.status === "agreed") {
    if (negotiation.medical?.status === "flagged") {
      return handOff("메디컬 소견이 붙었습니다");
    }
    if (negotiation.medical?.status === "scheduled") return;
    const signed: CommandResult = acceptDeal(state, negotiation.id);
    if (!signed.ok) return handOff(signed.message);
    if (statusAfter(negotiation) === "completed") {
      negotiation.mandate = null;
      say(`${player.name} ${kindKoName}${josaOf(kindKoName, "을/를")} 매듭지었습니다`);
    } else {
      say(`${player.name} ${kindKoName}에 합의했습니다 — ${signed.message}`);
    }
    return;
  }

  // ④ 서 있는 요구 — 한도 안이면 받는다
  const demand = standingDemand(negotiation);
  if (demand) {
    const over = overLimit(state, negotiation, player, demand);
    if (over) return handOff(`상대가 ${over}${josaOf(over, "을/를")} 부릅니다`);
    const taken: CommandResult = incomingOffer(negotiation)
      ? answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" })
      : acceptDeal(state, negotiation.id);
    if (!taken.ok) return handOff(taken.message);
    say(`${player.name} ${kindKoName} — 상대의 조건이 한도 안이라 그대로 받았습니다`);
    // 들어온 오퍼를 받으면 그 자리가 곧 합의다 — 서명도 같은 날이다
    if (statusAfter(negotiation) === "agreed") runMandate(state, negotiation, digest);
    return;
  }

  // ⑤ 값이 오간 적 없는 자리 — 재계약만 단장이 첫 제시를 넣는다
  if (negotiation.rounds.length === 0 && !negotiation.personal) {
    const first = openFor(state, player, negotiation.kind, negotiation.mandate ?? {});
    if (!first.ok) return handOff(first.message);
    say(`${player.name} ${kindKoName} — 첫 제시를 넣었습니다. ${first.message}`);
  }
}

/**
 * **매일의 tick** — 방침이 자리를 맡고 열고, 맡은 협상이 하루치를 굴린다
 * (기한 처리 뒤, 답 도착 알림 앞).
 */
export function runMandates(state: GameState, digest: TickSink): void {
  adoptByPolicy(state);
  openByPolicy(state, digest);
  for (const negotiation of [...state.negotiations]) {
    if (isMandated(negotiation)) runMandate(state, negotiation, digest);
  }
}
