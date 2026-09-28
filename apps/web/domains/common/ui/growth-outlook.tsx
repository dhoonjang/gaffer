import { GROWTH_LABELS, growthTier } from "../lib/scout-report-display";

export function GrowthOutlook({
  overall,
  potential,
}: {
  overall: number | null;
  potential: { low: number; high: number } | null;
}) {
  const tier = growthTier(overall, potential);
  return (
    <span
      title={
        tier === null
          ? "성장 가능성을 판단할 정보가 부족합니다"
          : tier === 5
            ? "성장 여지가 크고 리그 최정상 이상의 실력이 기대됩니다. 최종 능력치를 보장하지는 않습니다"
            : "현재 실력 대비 성장 여지의 추정입니다. 성장 속도나 최종 능력치를 보장하지 않습니다"
      }
    >
      {tier === null ? "판단 보류" : GROWTH_LABELS[tier]}
    </span>
  );
}
