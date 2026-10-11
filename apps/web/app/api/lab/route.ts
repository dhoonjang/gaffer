import { NextResponse } from "next/server";
import { createLabGame, pruneLabGames, saveGame } from "@gaffer/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";
import { LAB_KEPT, LabCreateSchema } from "@/game/lab-protocol";

export const runtime = "nodejs";

/** 실험실 판 짓기 — 두 구단 · 맡을 쪽 · 시드 (live-match.md §8.6) */
export const POST = adminWrite(async (request: Request) => {
  const body = LabCreateSchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return NextResponse.json({ error: "실험실 요청이 올바르지 않습니다" }, { status: 400 });
  const made = createLabGame(body.data);
  if (!made.ok) return NextResponse.json({ error: made.message }, { status: 400 });
  saveGame(made.state);
  pruneLabGames(LAB_KEPT);
  return NextResponse.json({ id: made.state.id });
});
