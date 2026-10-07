import {
  MandateRequestSchema,
  contractEndForYears,
  currentProposal,
  formatMoney,
  pushEvent,
  type Negotiation,
  type NegotiationAction,
  type NegotiationMandate,
  type ProposalTerms,
  type TickSink,
} from "@gaffer/domain";
import { managedTeamId, openInjury, playerName, type GameState } from "../core/state";
import { addDays } from "../core/dates";
import { negotiationBounds } from "./acceptance-bounds";
import { actNegotiation, type NegotiationActor } from "./negotiation";
import { marketTerms } from "./world-market";

/**
 * **감독이 맡긴 협상** (docs/team/transfers.md 「감독이 맡긴 협상」).
 *
 * 상한·연수·결론일은 GM이 정해 `delegateNegotiation`으로 남기고, 결론일에 조건을 정하는
 * 것은 코어다 — 공식은 NPC 시장과 하나다(`marketTerms`). 코어가 우리 구단으로 하는 일은
 * 제안 발송·메디컬 요청·위험 확인뿐이고, 서명은 감독의 확인 카드에 남는다.
 */

/** 합의한 제안이 감독의 서명을 기다리는 날 */
const MANDATE_SIGN_DAYS = 14;

interface MandateResult {
  ok: boolean;
  message: string;
}
const fail = (message: string): MandateResult => ({ ok: false, message });

export function delegateNegotiation(state: GameState, id: string, raw: unknown): MandateResult {
  if (state.phase === "match") return fail("경기 중에는 협상을 맡길 수 없습니다");
  const parsed = MandateRequestSchema.safeParse(raw);
  if (!parsed.success) return fail("위임 요청이 올바르지 않습니다");
  const request = parsed.data;
  const managed = managedTeamId(state);
  const n = state.negotiations.find((n) => n.id === id);
  if (!n || managed === null || n.buyerId !== managed)
    return fail("우리 구단이 영입 구단인 협상만 맡길 수 있습니다");
  if (n.status !== "open") return fail("진행 중인 협상이 아닙니다");
  const current = n.mandate;
  if (request.action === "revoke") {
    if (current?.stage !== "pending") return fail("결론을 기다리는 위임이 없습니다");
    closeMandate(state, n, current, "revoked", "감독이 위임을 거뒀다");
    return { ok: true, message: "위임을 거뒀습니다" };
  }
  if (current && (current.stage === "agreed" || current.stage === "ready"))
    return fail("이미 합의에 닿은 위임입니다. 서명은 감독의 확인 카드에서 합니다");
  if (request.minYears > request.maxYears) return fail("계약 연수의 범위가 거꾸로입니다");
  const decideOn = addDays(state.date, request.days);
  n.mandate = {
    grantedOn: state.date,
    decideOn,
    maxFee: n.kind === "transfer" ? request.maxFee : 0,
    maxWeeklyWage: request.maxWeeklyWage,
    minYears: request.minYears,
    maxYears: request.maxYears,
    stage: "pending",
    updatedOn: state.date,
    reason: "",
  };
  n.revision += 1;
  return { ok: true, message: `위임을 기록했습니다. ${decideOn}에 코어가 조건을 정합니다` };
}

/** 날짜 진행의 한 패스 — 결론일이 온 위임을 정하고, 합의한 영입의 메디컬을 받아 본다 */
export function progressMandates(state: GameState, sink: TickSink): void {
  const managed = managedTeamId(state);
  if (managed === null || state.phase === "match") return;
  for (const n of state.negotiations) {
    const m = n.mandate;
    if (!m || n.buyerId !== managed) continue;
    if (n.status !== "open") {
      // 협상이 다른 길로 닫혔다(소속 변경·철회) — 기다리던 위임도 함께 닫는다
      if (m.stage === "pending") closeMandate(state, n, m, "failed", "협상이 닫혔다");
      continue;
    }
    if (m.stage === "pending" && m.decideOn <= state.date) resolveMandate(state, n, m, sink);
    else if (m.stage === "agreed") reviewMedical(state, n, m, sink);
  }
}

function resolveMandate(
  state: GameState,
  n: Negotiation,
  m: NegotiationMandate,
  sink: TickSink,
): void {
  const name = playerName(state, n.playerId);
  const bounds = negotiationBounds(state, n);
  const market = marketTerms(state, { ...n, bounds });
  const fee = Math.min(market.fee, m.maxFee);
  const weeklyWage = Math.min(market.weeklyWage, m.maxWeeklyWage);
  const years = Math.min(Math.max(market.years, m.minYears), m.maxYears);
  const short =
    n.kind === "transfer" && fee < bounds.minFee
      ? "상대 구단이 받아들일 이적 대금이 맡긴 상한보다 높다"
      : weeklyWage < bounds.minWeeklyWage
        ? "선수가 받아들일 주급이 맡긴 상한보다 높다"
        : null;
  if (short) {
    closeMandate(state, n, m, "failed", short);
    pushEvent(sink, "contract", `${name} 위임 협상 결렬 — ${short}`);
    return;
  }
  const terms: ProposalTerms = {
    scope: "player",
    fee: 0,
    installments: [],
    weeklyWage,
    signingBonus: 0,
    since: market.since,
    until: contractEndForYears(market.since, years),
    expiresOn: addDays(state.date, MANDATE_SIGN_DAYS),
    promises: [],
  };
  // 상대의 수용 범위·우리 예산 중 하나라도 막히면 아무것도 남기지 않는다 — 사본에서 먼저 걷는다
  const blocked = agree(structuredClone(state), n.id, terms, fee) ?? agree(state, n.id, terms, fee);
  if (blocked) {
    closeMandate(state, n, m, "failed", blocked);
    pushEvent(sink, "contract", `${name} 위임 협상 결렬 — ${blocked}`);
    return;
  }
  const wage = `주급 ${formatMoney(weeklyWage)} · ${years}년`;
  if (n.kind === "renewal") {
    closeMandate(state, n, n.mandate!, "ready", "");
    pushEvent(sink, "contract", `${name} 재계약 위임 합의 — ${wage}. 감독 서명을 기다린다`);
    return;
  }
  closeMandate(state, n, n.mandate!, "agreed", "");
  const deal = n.kind === "transfer" ? `이적 대금 ${formatMoney(fee)} · ${wage}` : wage;
  pushEvent(sink, "contract", `${name} 영입 위임 합의 — ${deal}. 메디컬을 요청했다`);
}

/** 위임 권한으로 양측 합의와 메디컬 요청까지 — 막힌 자리의 이유를 돌려준다 */
function agree(state: GameState, id: string, terms: ProposalTerms, fee: number): string | null {
  const n = state.negotiations.find((n) => n.id === id)!;
  const ours: NegotiationActor = { kind: "mandate", partyId: n.buyerId };
  const step = (action: NegotiationAction, actor: NegotiationActor): string | null => {
    const result = actNegotiation(state, id, action, actor);
    return result.ok ? null : result.message;
  };
  const accept = (scope: ProposalTerms["scope"], partyId: string) =>
    step({ kind: "accept", proposalId: currentProposal(n, scope)!.id }, { kind: "model", partyId });
  return (
    (n.kind === "transfer"
      ? (step({ kind: "send", terms: { ...terms, scope: "club", weeklyWage: 0, fee } }, ours) ??
        accept("club", n.sellerId))
      : null) ??
    step({ kind: "send", terms }, ours) ??
    accept("player", n.playerId) ??
    (n.kind === "renewal" ? null : step({ kind: "medical" }, ours))
  );
}

function reviewMedical(
  state: GameState,
  n: Negotiation,
  m: NegotiationMandate,
  sink: TickSink,
): void {
  if (!n.medical?.examinedOn) return;
  const name = playerName(state, n.playerId);
  if (n.medical.injuries.length > 0 || openInjury(state, n.playerId)) {
    closeMandate(state, n, m, "returned", "메디컬에서 부상이 확인됐다");
    pushEvent(sink, "contract", `${name} 메디컬에서 부상 확인 — 위임이 감독에게 돌아왔다`);
    return;
  }
  const result = actNegotiation(
    state,
    n.id,
    { kind: "acknowledge_medical" },
    { kind: "mandate", partyId: n.buyerId },
  );
  if (!result.ok) return;
  closeMandate(state, n, n.mandate!, "ready", "");
  pushEvent(sink, "contract", `${name} 메디컬 통과 — 감독 서명을 기다린다`);
}

function closeMandate(
  state: GameState,
  n: Negotiation,
  m: NegotiationMandate,
  stage: NegotiationMandate["stage"],
  reason: string,
): void {
  n.mandate = { ...m, stage, updatedOn: state.date, reason };
  n.revision += 1;
}
