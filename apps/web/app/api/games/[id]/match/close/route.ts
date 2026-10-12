import { invalidGameId } from "@/app/api/games/game-id";
import { closeMatchLocked } from "@/game/turn-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 종료 휘슬의 마감 — 코어가 경기를 닫고 결산한 뒤 게임 전체를 돌려준다 (live-match.md §8.3) */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const closed = await closeMatchLocked(id);
  return closed.ok
    ? Response.json(closed.payload)
    : Response.json({ error: closed.error }, { status: closed.status });
}
