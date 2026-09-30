import {
  type TableSpeaker,
  type ClubColours,
  type NegotiationKind,
  type MarketTerms,
  type Negotiation,
  type NegotiationMethod,
  dealTermLabel,
} from "@story-fm/domain";
import { type GameState, playerById, teamNameIn, teamShortNameIn } from "../../common/core/state";
import { roomNegotiationOf, roomPartyOf, tableOf } from "../market/table";
import { tableVoicesOf } from "../market/counterparty";
import { clubColoursOf } from "../../common/views/colours";
import { negotiationKindKo, counterpartOf } from "../market/negotiation";
import { termSheetOf } from "../market/terms";

/** 협상 상대의 화자 토큰·이름·소속·직책. */
export interface NegotiationRoomVoiceView {
  speaker: TableSpeaker;
  name: string;
  /** 직책 — 단장 · 에이전트 · 선수 */
  title: string;
  /** 구단 쪽에만 — 화면이 문장과 구단 색을 세우는 열쇠 */
  team?: { id: string; name: string; short: string; colours?: ClubColours };
}

/** 조건서 한 줄 — 누가 · 무엇을 · 답 (transfer.md §12-3) */
export interface NegotiationRoomTermView {
  label: string;
  by: "us" | "them";
  /** 상대가 부른 요구의 답 — 감독이 건 조건과 답이 없는 요구는 null */
  answer: "granted" | "refused" | null;
}

/**
 * **협상 방** — 화면이 읽는 값 (transfer.md §12-2 · design-system.md §7-1).
 *
 * 경기의 `MatchView`와 같은 자리다: `phase`가 `negotiation`일 때만 서고, 게이트와 방의
 * 칸이 여기서만 읽는다. 값은 전부 장부에서 파생한다 — 화면이 새로 만드는 사실은 없다.
 */
export interface NegotiationRoomView {
  negotiationId: string;
  playerId: string;
  playerName: string;
  kind: NegotiationKind;
  /** 갈래의 이름 — 영입 · 매각 · 재계약 · 임대 영입 · 임대 송출 · 해지 · 사전 계약 */
  kindLabel: string;
  /** 건너편 — 이 방에 앉은 사람의 이름 */
  counterpart: string;
  /** 이 방의 상대 — 구단 쪽(단장)인가 선수 쪽(에이전트)인가 (transfer.md §12-2) */
  party: TableSpeaker;
  /** 이 방에 앉은 목소리 — 하나다 */
  voices: NegotiationRoomVoiceView[];
  /** 구단이 이미 이적료에 합의했으면 그 값 — 남은 것은 개인 조건이다 */
  feeAgreed: { fee: number; on: string } | null;
  contactId: string | null;
  method: NegotiationMethod;
  /** 우리 마지막 오퍼 · 상대의 마지막 조정안 — 없으면 null */
  ours: MarketTerms | null;
  theirs: MarketTerms | null;
  /** 개인 조건 선합의 — 제안·되부름·합의 (transfer.md §12-3) */
  personal: { weeklyWage: number; years: number; agreed: boolean; countered: boolean } | null;
  terms: NegotiationRoomTermView[];
  /** 사실로 확인된 설득 논거의 이름 */
  pitched: string[];
  loan: boolean;
  precontract: boolean;
  status: Negotiation["status"];
}

/** 라운드 한 벌 → 카드의 조건 — 갈래가 값의 이름을 고른다 (해지는 정산금, 재계약엔 이적료가 없다) */
export function roundTermsOf(
  negotiation: Negotiation,
  round: Negotiation["rounds"][number] | undefined,
): MarketTerms | null {
  if (!round) return null;
  const noFee = negotiation.kind === "renew" || negotiation.precontract === true;
  return {
    ...(negotiation.kind === "release"
      ? { severance: round.fee }
      : noFee
        ? {}
        : { fee: round.fee }),
    ...(negotiation.kind === "release" || round.contractYears <= 0
      ? {}
      : { weeklyWage: round.weeklyWage }),
    ...(round.contractYears > 0 ? { years: round.contractYears } : {}),
    ...(round.paymentYears !== undefined && round.paymentYears >= 2
      ? { paymentYears: round.paymentYears }
      : {}),
  };
}

/**
 * 협상 방 — `phase`가 `negotiation`일 때만 선다 (transfer.md §12-2). 값은 전부 협상의
 * 장부에서 파생한다: 상대와 현재 조건. 과거 대화는 채팅에서 읽는다.
 */
export function buildNegotiationView(state: GameState): NegotiationRoomView | null {
  const negotiation = roomNegotiationOf(state);
  const room = state.pendingNegotiation;
  if (!negotiation || !room) return null;
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return null;
  const party = roomPartyOf(state) ?? "agent";
  const voices = tableVoicesOf(state, negotiation)
    .filter((v) => v.speaker === party)
    .map((v): NegotiationRoomVoiceView => {
      const teamId = v.teamId ?? null;
      return {
        speaker: v.speaker,
        name: v.name,
        title: v.title,
        ...(teamId
          ? {
              team: {
                id: teamId,
                name: teamNameIn(state, teamId),
                short: teamShortNameIn(state, teamId),
                colours: clubColoursOf(teamId),
              },
            }
          : {}),
      };
    });
  const table = tableOf(state, negotiation, party);
  const rounds = negotiation.rounds;
  const lastOurs = [...rounds].reverse().find((r) => r.by === "us");
  const last = rounds[rounds.length - 1];
  const lastTheirs = last && last.by === "them" && last.verdict === "counter" ? last : undefined;
  const personal = negotiation.personal;
  return {
    negotiationId: negotiation.id,
    playerId: player.id,
    playerName: player.name,
    kind: negotiation.kind,
    kindLabel: negotiationKindKo(negotiation),
    counterpart: voices[0]?.name ?? counterpartOf(negotiation, player),
    party,
    voices,
    feeAgreed: negotiation.feeAgreed
      ? { fee: negotiation.feeAgreed.fee, on: negotiation.feeAgreed.on }
      : null,
    contactId: table?.id ?? null,
    method: room.method,
    ours: roundTermsOf(negotiation, lastOurs),
    theirs: roundTermsOf(negotiation, lastTheirs),
    personal: personal
      ? {
          weeklyWage: personal.counter?.weeklyWage ?? personal.weeklyWage,
          years: personal.counter?.contractYears ?? personal.contractYears,
          agreed: personal.agreedOn !== undefined,
          countered: personal.counter !== undefined,
        }
      : null,
    terms: termSheetOf(negotiation).map((row) => ({
      label: dealTermLabel(row.term),
      by: row.by,
      answer: row.answer ?? null,
    })),
    pitched: [...negotiation.pitched],
    loan: negotiation.kind === "loan" || negotiation.kind === "loan_out",
    precontract: negotiation.precontract === true,
    status: negotiation.status,
  };
}
