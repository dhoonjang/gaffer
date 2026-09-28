import { isPlayerDeal, type Negotiation, type TableSpeaker } from "@story-fm/domain";
import { type GameState, playerById } from "../../common/core/state";
import { agentForPlayer, directorOf } from "../../common/people/persona";
import { termKindsOf } from "./terms";
export interface CounterpartyVoice {
  speaker: TableSpeaker;
  name: string;
  title: string;
  teamId?: string;
  answers: readonly string[];
}

function moneyAxisKo(kind: Negotiation["kind"]): string {
  if (kind === "release") return "정산금";
  return kind === "loan" || kind === "loan_out" ? "임대료" : "이적료";
}

export function tableVoicesOf(state: GameState, negotiation: Negotiation): CounterpartyVoice[] {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return [];
  const kind = negotiation.kind;
  const precontract = negotiation.precontract;

  const hasMoneyAxis = kind !== "renew" && !precontract;
  const clubTakesMoney = hasMoneyAxis && !isPlayerDeal(kind);
  const outgoing = kind === "sell" || kind === "loan_out";
  const splittable = kind === "sell" || kind === "release" || (kind === "buy" && !precontract);
  const moneyAnswers = hasMoneyAxis
    ? [moneyAxisKo(kind), ...(splittable ? ["분할 연수"] : []), "기한"]
    : [];

  const personalAgreed = negotiation.personal?.agreedOn !== undefined;
  const personal =
    outgoing || kind === "release" || personalAgreed
      ? []
      : [
          "주급",
          ...(kind === "renew" ? ["계약 연수"] : []),
          ...(kind === "buy" || kind === "renew" ? ["계약 지위"] : []),
          ...(kind === "buy" ? ["등번호"] : []),
        ];
  // 조건은 언제나 선수 쪽이 부르고 답한다 — 조항도 보너스도 그의 계약서에 적히는 것이다
  if (termKindsOf(negotiation).length > 0) personal.push("조건");

  const agent = agentForPlayer(state, player.id);
  const voices: CounterpartyVoice[] = [];
  if (clubTakesMoney) {
    // 값을 답하는 것은 거래 상대 구단의 **단장**이다 — 빌려 온 선수의 원소속이 우리 팀과
    // 갈라지는 자리다 (§2). 구단이 아니라 사람이 앉는다 (people.md §2)
    const teamId = negotiation.counterpartTeamId ?? player.teamId;
    voices.push({
      speaker: "club",
      name: directorOf(state, teamId).name,
      title: "단장",
      teamId,
      answers: moneyAnswers,
    });
  }
  const playerSide = [...(clubTakesMoney ? [] : moneyAnswers), ...personal];
  if (playerSide.length > 0) {
    voices.push({
      speaker: "agent",
      // 명부에 에이전트가 없으면 선수 본인이 그 자리에 선다 — 화자를 지우지 않는다
      name: agent?.name ?? player.name,
      title: agent ? "에이전트" : "선수",
      answers: playerSide,
    });
  }

  const hears = voices[voices.length - 1];
  if (hears) hears.answers = [...hears.answers, "설득 논거의 답"];
  return voices;
}
