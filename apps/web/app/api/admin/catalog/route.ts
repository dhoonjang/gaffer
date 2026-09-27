import { NextResponse } from "next/server";
import { CatalogPlayerCreateSchema } from "@story-fm/domain";
import {
  adminAddCatalogPlayer,
  adminCatalog,
  adminResetCatalog,
  isCatalogEdited,
  CATALOG_AGE_REF,
} from "@story-fm/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/**
 * 선수 카탈로그 어드민 — 게임과 무관한 초기치 DB를 편집한다.
 * 여기서의 변경은 **이후 새로 시작하는 게임**에만 반영된다 (진행 중 세이브 무영향).
 */

export function GET() {
  return NextResponse.json({
    teams: adminCatalog(),
    edited: isCatalogEdited(),
    ageRef: CATALOG_AGE_REF,
  });
}

/** 카탈로그에 새 선수 추가 */
export const POST = adminWrite(async function (request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = CatalogPlayerCreateSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const { teamId, ...input } = body.data;
  const res = adminAddCatalogPlayer(teamId, input);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    message: res.message,
    playerId: res.playerId,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
});

/** 카탈로그를 시드 기본값으로 되돌린다 */
export const DELETE = adminWrite(async function () {
  const res = adminResetCatalog();
  return NextResponse.json({
    ok: true,
    message: res.message,
    teams: adminCatalog(),
    edited: isCatalogEdited(),
  });
});
