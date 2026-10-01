import {
  SQUAD_STATUSES,
  MAX_PAYMENT_YEARS,
  DEAL_TERM_KINDS,
  ESCALATOR_TRIGGERS,
  POSITION_CODES,
  type DealTerm,
  type NegotiationAssessment,
  type NegotiationTermsBundle,
} from "@story-fm/domain";
import type { GameEvaluator } from "@story-fm/llm";
import { evaluateChoices, evaluateNumber } from "../common/contextual-evaluation";

export interface NegotiationEvaluationInput {
  context: string;
  party: "club" | "agent";
  kind: string;
  current: NegotiationTermsBundle;
  factRefs: readonly string[];
  hasProposal: boolean;
  ending: boolean;
  medicalAllowed: boolean;
  alternativeOnly?: boolean;
  settled?: NegotiationAssessment;
}
/** Jev selects typed positions and exact numeric conditions. Prose never becomes a contract. */
export async function assessNegotiation(
  input: NegotiationEvaluationInput,
  evaluator: GameEvaluator,
): Promise<NegotiationAssessment> {
  const chosen = input.settled
    ? { position: input.settled.position, fact: input.settled.factRefs[0] }
    : await evaluateChoices(
        input.context,
        {
          position: {
            instructions:
              "상대의 현재 입장. 실제 계약·선수·구단 필요·이전 교환·감독이 제시한 이유를 함께 읽는다. 확률/인내/가격배수는 쓰지 않는다. agree는 발송된 조건 그대로 동의, counter는 구체적 수정 묶음, review는 추가 검토, end는 이번 협의 중단이다. 문의만 있었으면 agree할 제안이 없다.",
            criteria: input.alternativeOnly
              ? { counter: "서로 배타적인 대안 묶음" }
              : {
                  ...(input.hasProposal ? { agree: "발송된 조건 버전에 동의" } : {}),
                  counter: "수정 조건 또는 문의에 구체적 조건 제시",
                  review: "확인/검토가 필요",
                  end: "현재 협의 중단",
                },
          },
          fact: {
            instructions: "이번 판단을 가장 직접적으로 뒷받침하는 실제 입력 사실 묶음",
            criteria: Object.fromEntries(input.factRefs.map((ref) => [ref, ref])),
          },
        },
        evaluator,
      );
  const conditions = structuredClone(input.settled?.conditions ?? input.current);
  if (chosen.position === "counter" && !input.settled) {
    const coupled = JSON.stringify({
      facts: JSON.parse(input.context),
      instruction:
        "각 값은 같은 계약 묶음의 일부다. 다른 축과 교환관계를 고려한다. 시장가/현재주급은 참고만 하며 배수 제한이 아니다.",
    });
    if (input.party === "club") {
      conditions.fee = await evaluateNumber(
        coupled,
        "상대가 요구하는 정확한 이적료/임대료 (£). 한도는 저장 표현 범위다.",
        { min: 0, max: 1_000_000_000_000 },
        evaluator,
      );
      conditions.paymentYears = await evaluateNumber(
        JSON.stringify({ context: JSON.parse(coupled), conditions }),
        "이 총액과 함께 요구하는 지급 연수. 1은 일시금.",
        { min: 1, max: input.kind === "loan" || input.kind === "loan_out" ? 1 : MAX_PAYMENT_YEARS },
        evaluator,
      );
    } else {
      const bundle = () => JSON.stringify({ context: JSON.parse(coupled), conditions });
      conditions.weeklyWage = await evaluateNumber(
        bundle(),
        "선수 측이 요구하는 정확한 주급 (£). 해지는 0.",
        { min: 0, max: input.kind === "release" ? 0 : 1_000_000_000 },
        evaluator,
      );
      conditions.contractYears = await evaluateNumber(
        bundle(),
        "이 주급과 함께 원하는 계약 기간(년). 해지는 0.",
        { min: input.kind === "release" ? 0 : 1, max: input.kind === "release" ? 0 : 6 },
        evaluator,
      );
      const role = await evaluateChoices(
        bundle(),
        {
          role: {
            instructions: "앞서 정한 주급·기간과 함께 요구하는 역할",
            criteria: {
              none: "역할 요구 없음",
              ...Object.fromEntries(SQUAD_STATUSES.map((s) => [s, s])),
            },
          },
        },
        evaluator,
      );
      if (role.role !== "none")
        conditions.squadStatus = role.role as (typeof SQUAD_STATUSES)[number];
      else delete conditions.squadStatus;
      if (input.kind === "release")
        conditions.fee = await evaluateNumber(
          coupled,
          "상호 해지에 요구하는 정확한 정산금 (£). 계약상 일방해지 의무는 참고 사실이며 당사자 합의의 상한이 아니다.",
          { min: 0, max: 1_000_000_000_000 },
          evaluator,
        );
    }
    if (input.party === "agent")
      conditions.terms = await counterTerms(
        JSON.stringify({ ...JSON.parse(input.context), conditions }),
        conditions.terms,
        evaluator,
      );
  }
  let followup: NegotiationAssessment["followup"] = null;
  if (input.ending && !input.alternativeOnly && chosen.position !== "end") {
    const followupContext = JSON.stringify({
      context: JSON.parse(input.context),
      position: chosen.position,
      conditions,
    });
    const followupChoice = await evaluateChoices(
      followupContext,
      {
        followup: {
          instructions:
            "이번 교환을 마친다. 실제로 필요한 다음 일만 선택한다. 반복 연락이나 고정 지연을 만들지 않는다. none이면 예약하지 않는다.",
          criteria: {
            none: "후속 일정 필요 없음",
            response: "상대 검토 뒤 응답",
            renegotiate: "새 사실/선행 결정 뒤 다시 논의",
            ...(!input.medicalAllowed ? {} : { medical: "실제 건강 상태 검진이 필요" }),
          },
        },
      },
      evaluator,
    );
    if (followupChoice.followup !== "none") {
      const schedulingContext = JSON.stringify({
        assessment: JSON.parse(followupContext),
        purpose: followupChoice.followup,
      });
      const [days, decision] = await Promise.all([
        evaluateNumber(
          schedulingContext,
          "다음 일이 실제로 필요한 게임 일수. 0은 같은 날 다음 처리 단위. 실제 등록 기한과 약속한 일정을 확인하며 임의 기본 일수는 쓰지 않는다.",
          { min: 0, max: 3650 },
          evaluator,
        ),
        evaluateChoices(
          schedulingContext,
          {
            decision: {
              instructions:
                "이 후속 일을 처리할 때 감독의 결정이 필요한가? 단순 발송 확인은 결정이 아니다.",
              criteria: { yes: "감독 결정 필요", no: "단순 진행/통지" },
            },
          },
          evaluator,
        ),
      ]);
      followup = {
        purpose: followupChoice.followup as "response" | "renegotiate" | "medical",
        days,
        requiresDecision: decision.decision === "yes",
      };
    }
  }
  const alternatives: NegotiationTermsBundle[] = structuredClone(input.settled?.alternatives ?? []);
  if (chosen.position === "counter" && !input.alternativeOnly && !input.settled) {
    const alternative = await evaluateChoices(
      JSON.stringify({ context: JSON.parse(input.context), conditions }),
      {
        alternative: {
          instructions:
            "현재 묶음과 서로 배타적이며 상대가 실제로 받아들일 별도 대안이 필요한가? 같은 조건을 반복하거나 빈 대안을 만들지 않는다.",
          criteria: { none: "대안 없음", offer: "교환관계가 다른 구체적인 대안 하나" },
        },
      },
      evaluator,
    );
    if (alternative.alternative === "offer") {
      const other = await assessNegotiation(
        {
          ...input,
          current: conditions,
          context: JSON.stringify({
            ...JSON.parse(input.context),
            primaryConditions: conditions,
            instruction: "primaryConditions와 다른 교환관계를 가진 대안을 제시한다",
          }),
          hasProposal: false,
          medicalAllowed: false,
          alternativeOnly: true,
        },
        evaluator,
      );
      if (JSON.stringify(other.conditions) !== JSON.stringify(conditions))
        alternatives.push(other.conditions);
    }
  }
  return {
    position: chosen.position as NegotiationAssessment["position"],
    conditions,
    alternatives,
    factRefs: input.settled?.factRefs ?? [chosen.fact!],
    followup,
  };
}

async function counterTerms(
  context: string,
  current: DealTerm[],
  evaluator: GameEvaluator,
): Promise<DealTerm[]> {
  const facts = JSON.parse(context) as { facts: { availableTerms: string[] } };
  const kinds = DEAL_TERM_KINDS.filter(
    (k) => k !== "other" && facts.facts.availableTerms.includes(k),
  );
  const decisions = await evaluateChoices(
    context,
    Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          instructions: `같은 급여·기간·지위 묶음에 ${kind} 조건을 실제로 요구하는가? 필요 없는 조건을 자동 부착하지 않는다. 기존 조건을 유지하거나 생략하는 것도 판단이다.`,
          criteria: { yes: "이 조건을 요구", no: "요구하지 않음" },
        },
      ]),
    ),
    evaluator,
  );
  const terms = await Promise.all(
    kinds
      .filter((kind) => decisions[kind] === "yes")
      .map(async (kind): Promise<DealTerm> => {
        if (kind === "buyout" || kind === "bonus" || kind === "points")
          return {
            kind,
            fee: await evaluateNumber(
              context,
              `${kind} 조항의 정확한 금액(£). points는 골·도움 하나당 지급액이다.`,
              { min: 0, max: 1_000_000_000_000 },
              evaluator,
            ),
          };
        if (kind === "number")
          return {
            kind,
            number: await evaluateNumber(
              context,
              "요구하는 등번호. 실제 배정 현황과 선수 의사를 읽는다.",
              { min: 1, max: 99 },
              evaluator,
            ),
          };
        if (kind === "signing") {
          const selected = await evaluateChoices(
            context,
            {
              position: {
                instructions: "추가 영입을 요구하는 실제 포지션",
                criteria: Object.fromEntries(POSITION_CODES.map((p) => [p, p])),
              },
            },
            evaluator,
          );
          return { kind, position: selected.position };
        }
        if (kind === "escalator") {
          const [pct, trigger] = await Promise.all([
            evaluateNumber(
              context,
              "사건 발생 시 계약 주급 인상률(%)",
              { min: 1, max: Number.MAX_SAFE_INTEGER },
              evaluator,
            ),
            evaluateChoices(
              context,
              {
                trigger: {
                  instructions: "주급 인상 조항이 발동하는 사건",
                  criteria: Object.fromEntries(ESCALATOR_TRIGGERS.map((t) => [t, t])),
                },
              },
              evaluator,
            ),
          ]);
          return { kind, pct, trigger: trigger.trigger as (typeof ESCALATOR_TRIGGERS)[number] };
        }
        return { kind };
      }),
  );
  return [...terms, ...current.filter((t) => t.kind === "other")];
}
