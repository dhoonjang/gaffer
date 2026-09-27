import { NextResponse } from "next/server";
import { CatalogPlayerEditSchema } from "@story-fm/domain";
import {
  adminCatalog,
  adminEditCatalogPlayer,
  adminRemoveCatalogPlayer,
  isCatalogEdited,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/** 카탈로그 선수 편집 */
export const PATCH = adminWrite(async function (
  request: Request,
  context: { params: Promise<{ playerId: string }> },
) {
  const { playerId } = await context.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = CatalogPlayerEditSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  // 이동·포지션·수치를 한 번에 넘긴다 — 엔진이 셋을 다 검증한 뒤 한 번 쓴다.
  // 나눠 부르면 뒤가 거절될 때 앞의 절반만 파일에 남고 화면은 갱신되지 않는다.
  const res = adminEditCatalogPlayer(playerId, body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    message: res.message,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
});

/** 카탈로그에서 선수 삭제 */
export const DELETE = adminWrite(async function (
  _request: Request,
  context: { params: Promise<{ playerId: string }> },
) {
  const { playerId } = await context.params;
  const res = adminRemoveCatalogPlayer(playerId);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    message: res.message,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
});
