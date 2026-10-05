import type { GrowthOutlook as Outlook } from "@gaffer/domain";

/** 막대 수 — 매우 낮음(0)이 한 칸, 매우 높음(4)이 다섯 칸. 탁월함(5)은 다섯 칸이 금으로 선다 */
const GROWTH_BARS = 5;

export function GrowthOutlook({ growth }: { growth: Outlook | null }) {
  // 빈 막대는 최저 단계로 읽힌다 — 판단 보류는 글자로 둔다 (design-system.md)
  if (growth === null) return <span title="성장 가능성을 판단할 정보가 부족합니다">판단 보류</span>;
  const { tier, label } = growth;
  const exceptional = growth.key === "exceptional";
  const lit = Math.min(tier + 1, GROWTH_BARS);
  return (
    <span
      className={exceptional ? "growth-bars top" : "growth-bars"}
      role="img"
      aria-label={`성장 가능성 ${label}`}
      title={
        exceptional
          ? `${label} — 성장 여지가 크고 리그 최정상 이상의 실력이 기대됩니다. 최종 능력치를 보장하지는 않습니다`
          : `${label} — 현재 실력 대비 성장 여지의 추정입니다. 성장 속도나 최종 능력치를 보장하지 않습니다`
      }
    >
      {Array.from({ length: GROWTH_BARS }, (_, i) => (
        <i key={i} className={i < lit ? "on" : undefined} />
      ))}
    </span>
  );
}
