import { type GameState, playerById, teamNameIn, activeContract } from "../../common/core/state";
import {
  type ScoutReportCard,
  type ScoutGrade,
  naturalPositionOf,
  AXIS_GROUPS,
  AXIS_GROUP_KO,
  ageOf,
  type MissionReportCard,
  type GamePlayer,
} from "@story-fm/domain";
import {
  ratingLabel,
  ratingTier,
  scoutedAttributes,
  arrivedScoutReport,
  observedOverall,
  missionBrief,
  missionScope,
} from "../players/scouting";
import {
  potentialBand,
  observedRating,
  observationMargin,
  observationOf,
  type Knowledge,
} from "../../common/players/observation";
import {
  marketValueOf,
  askingPriceFor,
  wageExpectationOf,
  observedMarketValue,
} from "../market/market";
import { formatMoney } from "../finance/finance";
import { type PlayerCardView } from "../../app/player-card";

// ── 스카우팅 보고서 — 채팅이 카드로 그린다 ──────────────

/**
 * 스카우트가 가져온 **보고서 한 장**을 조립한다 — 안개는 `observedRating`이 이미 씌운다.
 *
 * **한 번 읽고 넘어갈 정보가 아니다** — 능력치 16축·주발·잠재력 구간·몸값이
 * 한자리에 있어야 "지금 지를까, 더 볼까"가 판단된다. 그래서 카드다.
 */
export function scoutReportCard(state: GameState, playerId: string): ScoutReportCard | null {
  const p = playerById(state, playerId);
  if (!p) return null;
  const grade = (value: number): ScoutGrade => ({
    label: ratingLabel(value),
    tier: ratingTier(value),
    value,
  });
  // 필드 플레이어의 골키핑은 어디에도 쓰이지 않는다 — 보고서에 두면 줄만 잡아먹는다
  const isKeeper = naturalPositionOf(p).position === "GK";
  const band = potentialBand(state, p);
  const groupOfAxis = (axis: string): string => {
    for (const [key, axes] of Object.entries(AXIS_GROUPS)) {
      if ((axes as readonly string[]).includes(axis)) {
        return AXIS_GROUP_KO[key as keyof typeof AXIS_GROUPS];
      }
    }
    return "";
  };
  return {
    playerId: p.id,
    name: p.name,
    team: teamNameIn(state, p.teamId),
    age: ageOf(p.birthdate, state.date),
    position: naturalPositionOf(p).position,
    positions: p.positions.map((x) => ({
      position: x.position,
      proficiency: x.proficiency,
      natural: x.isNatural === true,
    })),
    foot: p.foot ?? { left: 3, right: 3 },
    height: p.height ?? null,
    weight: p.weight ?? null,
    overall: {
      ...grade(observedRating(state, p.id, "overall", p.attributes.overall)),
      margin: observationMargin(state, p.id, "overall"),
    },
    potential: band ? { low: grade(band.low), high: grade(band.high) } : null,
    attributes: scoutedAttributes(state, p)
      .filter((a) => a.key !== "goalkeeping" || isKeeper)
      .map((a) => {
        const value = a.exact ?? observedRating(state, p.id, a.key, p.attributes[a.key] as number);
        return {
          key: a.key,
          ko: a.ko,
          value,
          tier: ratingTier(value),
          exact: a.exact !== null,
          margin: observationMargin(state, p.id, a.key),
          group: groupOfAxis(a.key),
        };
      }),
    marketValue: marketValueOf(state, p),
    askingPrice: askingPriceFor(state, p),
    wageExpectation: wageExpectationOf(state, p),
    contractUntil: activeContract(state, p.id)?.until ?? null,
    verdict: arrivedScoutReport(state, p.id)?.verdict ?? null,
  };
}

/**
 * 보고서 한 장을 **사실 한 줄로** — 도착 다이제스트가 모델에 넘기는 통로.
 *
 * 카드는 모델이 장면을 **쓴 뒤에** 붙어 화면에만 간다. 그래서 도착한 턴의 모델은
 * 금액을 어디서도 읽지 못하고, 읽지 못하면 지어낸다 — 카드는 £34.9M인데 대사는
 * 4,000만이 된다. 한 화면이 두 말을 하는 순간 둘 다 못 믿는다.
 *
 * ⚠️ **카드에서 파생한다.** 같은 값을 두 번 조립하면 한쪽만 고쳐질 때 다시 갈린다.
 * 코어는 사실만 내고 문장은 GM이 쓴다 (선수 근황 cues와 같은 결).
 */
export function scoutReportLine(state: GameState, playerId: string): string | null {
  const card = scoutReportCard(state, playerId);
  if (!card) return null;
  const overall =
    `종합 ${card.overall.value}` +
    (card.overall.margin > 0 ? `±${card.overall.margin}` : "") +
    ` (${card.overall.label})`;
  return [
    `${card.name} (${card.team}) ${card.age}세 ${card.position}`,
    overall,
    // 잠재력은 끝까지 폭으로만 안다 — 한 숫자로 적으면 모델이 그걸 단정한다 (player.md §9.1)
    card.potential
      ? `잠재력 ${card.potential.low.value}~${card.potential.high.value}`
      : "잠재력 미지",
    `시장가 ${formatMoney(card.marketValue)}`,
    `요구액 ${formatMoney(card.askingPrice)}`,
    `기대 주급 ${formatMoney(card.wageExpectation)}`,
    ...(card.contractUntil ? [`계약 ${card.contractUntil}까지`] : []),
  ].join(" · ");
}

// ── 스카우트 임무 보고 — 조건 한 벌이 데려온 후보 (player.md §9.4) ──

/**
 * 임무가 데려온 **후보 다섯 장**을 조립한다.
 *
 * 보고서 카드(`scoutReportCard`)와 다른 물음에 답한다 — 저쪽은 「이 선수가 어떤가」라
 * 16축을 펴고, 이쪽은 「누가 있나」라 다섯 줄이 나란히 선다.
 *
 * ⚠️ **금액도 흐린 값이다.** 후보는 `seen` 눈금이라 시장가의 흐림 폭이 0이 아니다
 * (player.md §10). 보고서 카드가 참값을 쓰는 것은 카드라서가 아니라 스카우팅을
 * 마친 선수의 폭이 0이기 때문이고, 임무의 후보는 아직 그 자리가 아니다.
 *
 * ⚠️ **줄을 세운 값과 같은 값을 찍는다** — 종합은 `observedOverall`, 곧
 * `rankMissionCandidates`가 읽은 그 숫자다.
 */
export function missionReportCard(state: GameState, missionId: string): MissionReportCard | null {
  const mission = state.scoutMissions.find((m) => m.id === missionId);
  if (!mission || mission.completedOn === null) return null;
  const candidates = (mission.candidates ?? [])
    .map((id) => playerById(state, id))
    .filter((p): p is GamePlayer => p !== null)
    .map((p) => {
      const value = observedOverall(p.attributes.overall, observationOf(state, p.id));
      const band = potentialBand(state, p);
      return {
        playerId: p.id,
        name: p.name,
        team: teamNameIn(state, p.teamId),
        age: ageOf(p.birthdate, state.date),
        position: naturalPositionOf(p).position,
        overall: {
          label: ratingLabel(value),
          tier: ratingTier(value),
          value,
          margin: observationMargin(state, p.id, "overall"),
        },
        potential: band ? { low: band.low, high: band.high } : null,
        marketValue: observedMarketValue(state, p),
        contractUntil: activeContract(state, p.id)?.until ?? null,
      };
    });
  return {
    missionId: mission.id,
    brief: missionBrief(mission),
    scope: missionScope(mission),
    requestedOn: mission.requestedOn,
    completedOn: mission.completedOn,
    candidates,
  };
}

/**
 * 임무 보고를 **사실 한 줄로** — 도착 다이제스트가 모델에 넘기는 통로.
 *
 * ⚠️ **카드에서 파생한다** (`scoutReportLine`과 같은 규약). 카드는 프롬프트에 가지
 * 않으므로, 이 줄이 없으면 도착한 턴의 모델은 후보의 값을 어디서도 읽지 못하고
 * 지어낸다 — 그러면 카드의 다섯과 대사의 다섯이 다른 선수가 된다.
 */
export function missionReportLine(state: GameState, missionId: string): string | null {
  const card = missionReportCard(state, missionId);
  if (!card) return null;
  const label = `${card.scope} · ${card.brief}`;
  if (card.candidates.length === 0) return `${label} → 조건에 맞는 선수를 찾지 못했다`;
  const rows = card.candidates.map((c) =>
    [
      `${c.name} (${c.team}) ${c.age}세 ${c.position}`,
      `종합 ${c.overall.value}${c.overall.margin > 0 ? `±${c.overall.margin}` : ""}`,
      // 잠재력은 끝까지 폭으로만 안다 — 한 숫자로 적으면 모델이 그걸 단정한다
      c.potential ? `잠재력 ${c.potential.low}~${c.potential.high}` : "잠재력 미지",
      `시장가 ${formatMoney(c.marketValue)}`,
      ...(c.contractUntil ? [`계약 ${c.contractUntil}까지`] : []),
    ].join(" "),
  );
  return `${label} → 후보 ${card.candidates.length}명: ${rows.join(" / ")}`;
}

/**
 * 그 선수 한 장을 짓는다 — 없는 선수면 null.
 *
 * **명단 행이 쓰는 그 함수들을 그대로 지난다**(`observedRating` · `observedFit` ·
 * `potentialBand` · `observedMarketValue`) — 카드가 제 자를 따로 들면 같은 선수의
 * 종합이 명단과 카드에서 두 숫자로 선다.
 */
/**
 * 모달에 서는 보고서 칸 — 조회 도구의 한 줄(`lookup.ts`)과 **같은 자에서** 낸다.
 * 값이 갈리면 감독이 보는 화면과 GM이 읽는 줄이 두 말을 한다.
 */
export function scoutReportFacts(
  state: GameState,
  p: GamePlayer,
  knowledge: Knowledge,
): PlayerCardView["scoutReport"] {
  const report = knowledge === "own" ? null : arrivedScoutReport(state, p.id);
  if (!report?.completedOn) return null;
  return {
    on: report.completedOn,
    askingPrice: askingPriceFor(state, p),
    wageExpectation: wageExpectationOf(state, p),
    verdict: report.verdict ?? null,
  };
}
