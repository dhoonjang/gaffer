import { NextResponse } from "next/server";
import {
  adminPersonaCatalog,
  adminResetPersonaCatalog,
  adminUpdatePersonaBook,
} from "@gaffer/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

function seedOf(request: Request): number | null {
  const value = new URL(request.url).searchParams.get("seed");
  if (value === null) return 0;
  if (!/^\d+$/u.test(value)) return null;
  const seed = Number(value);
  return Number.isSafeInteger(seed) && seed <= 0xffff_ffff ? seed : null;
}

export function GET(request: Request) {
  const seed = seedOf(request);
  if (seed === null)
    return NextResponse.json({ error: "유효한 시드가 필요합니다" }, { status: 400 });
  return NextResponse.json({ people: adminPersonaCatalog(seed), seed });
}

export const PATCH = adminWrite(async function (request: Request) {
  const seed = seedOf(request);
  if (seed === null)
    return NextResponse.json({ error: "유효한 시드가 필요합니다" }, { status: 400 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("characterId" in raw) ||
    typeof raw.characterId !== "string" ||
    !("lorebook" in raw)
  ) {
    return NextResponse.json({ error: "인물과 로어북이 필요합니다" }, { status: 400 });
  }
  const result = adminUpdatePersonaBook(raw.characterId, raw.lorebook, seed);
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
  return NextResponse.json({ people: adminPersonaCatalog(seed), seed, message: result.message });
});

export const DELETE = adminWrite(function (request: Request) {
  const seed = seedOf(request);
  if (seed === null)
    return NextResponse.json({ error: "유효한 시드가 필요합니다" }, { status: 400 });
  const result = adminResetPersonaCatalog();
  return NextResponse.json({ people: adminPersonaCatalog(seed), seed, message: result.message });
});
