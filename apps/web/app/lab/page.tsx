import { MatchLab } from "@/game/match-lab";

/** 경기 실험실 — `?id=`가 있으면 그 판을 다시 연다 (docs/match/live-match.md §8.6) */
export default async function LabPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const { id } = await searchParams;
  return <MatchLab labId={typeof id === "string" ? id : null} />;
}
