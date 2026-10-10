/**
 * 카드 기준점의 자리별 평균 축 — `packages/domain/src/players/slot-reference.ts`를 쓴다
 * (docs/players/player.md §3).
 *
 *   pnpm slot-reference           리포트만 낸다 (기본값 — 아무것도 쓰지 않는다)
 *   pnpm slot-reference --write   표를 다시 쓴다
 *
 * 시드 카탈로그(편집 전 원본)에서 주 자리마다 종합 축의 평균을 낸다. CF 묶음에는 주 자리로
 * 서는 선수가 없다 — 그 줄은 같은 자리(ST)의 선수가 채운다.
 *
 * ⚠️ **이 스크립트만이 그 표를 쓴다.** 시드나 축 파생이 바뀌면 다시 돌린다 — 어긋남은
 * `attributes.test.ts`가 잡는다.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OVERALL_AXES,
  naturalPositionOf,
  weightSlotOf,
  type OverallAxis,
  type WeightSlot,
} from "../packages/domain/src/players/player";
import { seedCatalog } from "../packages/engine/src/players/catalog/catalog";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const OUT = path.join(REPO, "packages/domain/src/players/slot-reference.ts");
const SLOTS: readonly WeightSlot[] = ["GK", "CB", "FB", "DM", "CM", "AM", "W", "CF", "ST"];
/** 주 자리로 서는 선수가 없는 묶음 — 그 칸이 접히는 자리의 선수가 채운다 */
const POPULATION_OF: Partial<Record<WeightSlot, WeightSlot>> = { CF: "ST" };

// 데이터 디렉터리의 편집본을 읽지 않는다 — 기준은 시드다
process.env.GAFFER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "gaffer-slot-reference-"));

const sums = new Map<WeightSlot, { n: number; axes: Record<OverallAxis, number> }>();
for (const entry of seedCatalog()) {
  const slot = weightSlotOf(naturalPositionOf(entry).position);
  const row = sums.get(slot) ?? {
    n: 0,
    axes: Object.fromEntries(OVERALL_AXES.map((a) => [a, 0])) as Record<OverallAxis, number>,
  };
  row.n += 1;
  for (const axis of OVERALL_AXES) row.axes[axis] += entry[axis];
  sums.set(slot, row);
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const lines: string[] = [];
for (const slot of SLOTS) {
  const row = sums.get(POPULATION_OF[slot] ?? slot);
  if (!row) throw new Error(`주 자리 선수가 없는 묶음: ${slot}`);
  const means = OVERALL_AXES.map((axis) => `${axis}: ${round1(row.axes[axis] / row.n)}`);
  lines.push(`  ${slot}: { ${means.join(", ")} },`);
  console.log(`${slot.padEnd(3)} n=${row.n}`);
}

const file = `import type { OverallAxis, WeightSlot } from "./player";

/**
 * 자리 묶음마다 그 자리 선수의 **평균 축** — 카드 기준점의 기준 선수다 (player.md §3).
 * 평균적인 선수가 어느 카드에서도 기본 카드와 같은 값을 내도록 \`cardFit\`이 평행 이동한다.
 *
 * ⚠️ \`pnpm slot-reference --write\`가 쓰는 생성 파일이다 — 손으로 고치면 다음 실행이 되돌린다.
 */
export const SLOT_REFERENCE: Readonly<Record<WeightSlot, Readonly<Record<OverallAxis, number>>>> = {
${lines.join("\n")}
};
`;

if (process.argv.includes("--write")) {
  writeFileSync(OUT, file, "utf8");
  console.log(`썼다: ${path.relative(REPO, OUT)}`);
}
