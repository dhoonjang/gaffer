import { GROWTH_LABELS, growthTier } from "../lib/scout-report-display";

/** 막대 수 — 매우 낮음(0)이 한 칸, 매우 높음(4)이 다섯 칸. 탁월함(5)은 다섯 칸이 금으로 선다 */
const GROWTH_BARS = 5;

export function GrowthOutlook({
  overall,
  potential,
}: {
  overall: number | null;
  potential: { low: number; high: number } | null;
}) {
  const tier = growthTier(overall, potential);
  // 빈 막대는 최저 단계로 읽힌다 — 판단 보류는 글자로 둔다 (design-system.md)
  if (tier === null) return <span title="성장 가능성을 판단할 정보가 부족합니다">판단 보류</span>;
  const label = GROWTH_LABELS[tier];
  const lit = Math.min(tier + 1, GROWTH_BARS);
  return (
    <span
      className={tier === 5 ? "growth-bars top" : "growth-bars"}
      role="img"
      aria-label={`성장 가능성 ${label}`}
      title={
        tier === 5
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
