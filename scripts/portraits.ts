/**
 * 선수 초상 내보내기 — 생성 원본을 화면이 쓰는 두 벌로 자르고 보유 목록을 다시 쓴다.
 *
 *   pnpm portraits [작업 폴더]       기본값 `.next-portraits`
 *   pnpm portraits --keep            초상은 다시 자르지 않고 목록과 출처 표만 다시 쓴다
 *
 * 세 가지를 낸다:
 *   apps/web/public/portraits/{h,p}/<선수 id>.webp   초상 (저장소 밖 — .gitignore)
 *   apps/web/public/portraits/credits.html          원본 사진의 저작자·라이선스 (설정 메뉴가 연다)
 *   packages/domain/src/players/portrait-index.ts   초상을 가진 선수 id 목록 (저장소 안)
 *
 * 열쇠는 카탈로그의 `wikidataId`다. 파일 이름은 선수 id라 화면은 id만으로 주소를 낸다 —
 * 가명본 시드에서는 id가 달라지므로 초상이 한 장도 붙지 않는다.
 *
 * 자르는 일은 `scripts/portraits/export.py`가 한다 (Pillow · numpy).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { playerCatalog } from "../packages/engine/src/players/catalog/catalog";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const work = path.resolve(
  args.find((a) => !a.startsWith("--")) ?? path.join(ROOT, ".next-portraits"),
);
const out = path.join(ROOT, "apps/web/public/portraits");
const indexFile = path.join(ROOT, "packages/domain/src/players/portrait-index.ts");

interface ManifestRow {
  qid: string;
  nameKo: string;
  artist?: string;
  license?: string;
  licenseUrl?: string;
  page?: string;
}
interface ExportRow {
  id: string;
  qid: string;
  unfilled?: boolean;
  error?: string;
}

const idOf: Record<string, string> = {};
for (const p of playerCatalog()) if (p.wikidataId !== undefined) idOf[p.wikidataId] = p.id;

mkdirSync(out, { recursive: true });
// 자르는 쪽이 읽는 다리 표 — 자산 폴더에 두면 화면용 파일과 함께 올라간다
const mapFile = path.join(tmpdir(), "gaffer-portrait-ids.json");
writeFileSync(mapFile, JSON.stringify(idOf));

/** 이미 잘라 둔 초상 — 파일이 있는 선수가 곧 목록이다 */
function kept(): ExportRow[] {
  const qidOf = Object.fromEntries(Object.entries(idOf).map(([qid, id]) => [id, qid]));
  return readdirSync(path.join(out, "h"))
    .filter((f) => f.endsWith(".webp"))
    .map((f) => f.slice(0, -".webp".length))
    .map((id) => ({ id, qid: qidOf[id] ?? "" }));
}

function exported(): ExportRow[] {
  const run = spawnSync(
    "python3",
    ["-I", path.join(ROOT, "scripts/portraits/export.py"), work, out, mapFile],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (run.status !== 0) throw new Error(`export.py가 ${String(run.status)}로 끝났다`);
  return JSON.parse(run.stdout) as ExportRow[];
}

const report = keep ? kept() : exported();
const made = report.filter((r) => !r.unfilled && r.error === undefined);
const ids = made.map((r) => r.id).sort();

/** 초상 한 벌의 판 — 다시 내보내면 주소가 바뀌어 브라우저가 옛 장을 쓰지 않는다 */
const version = createHash("sha256").update(ids.join(" ")).update(String(Date.now())).digest("hex");

writeFileSync(
  indexFile,
  `/**
 * 초상을 가진 선수 — \`pnpm portraits\`가 쓴다. 손으로 고치지 않는다.
 *
 * 한 줄 문자열인 이유: 천 줄 넘는 배열은 diff와 번들에서 값보다 따옴표가 더 무겁다.
 */
export const PORTRAIT_VERSION = "${version.slice(0, 8)}";

export const PORTRAIT_IDS: ReadonlySet<string> = new Set(
  // prettier-ignore
  "${ids.join(" ")}".split(" "),
);
`,
);

const manifest = JSON.parse(
  readFileSync(path.join(work, "manifest.json"), "utf8"),
) as ManifestRow[];
const shown = new Set(made.map((r) => r.qid));
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const credits = manifest
  .filter((m) => shown.has(m.qid))
  .sort((a, b) => a.nameKo.localeCompare(b.nameKo, "ko"))
  .map(
    (m) =>
      `<tr><td>${escape(m.nameKo)}</td><td>${escape(m.artist ?? "")}</td>` +
      `<td><a href="${escape(m.licenseUrl ?? "")}">${escape(m.license ?? "")}</a></td>` +
      `<td><a href="${escape(m.page ?? "")}">원본</a></td></tr>`,
  )
  .join("\n");
/**
 * 출처 표 — 자산과 같은 폴더에 서는 홀로 선 문서다. 원본이 CC BY·BY-SA 사진이라 저작자와
 * 라이선스, 그리고 고쳐 썼다는 사실을 함께 적는다. 앱 번들에 싣지 않는다: 초상이 올라간
 * 배포에만 필요하고, 그 배포에는 이 파일이 초상과 함께 올라간다.
 */
writeFileSync(
  path.join(out, "credits.html"),
  `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>초상 출처 — Gaffer</title>
<style>
body{margin:0;padding:32px 16px;background:#0a0d0b;color:#f2efe6;font:14px/1.6 system-ui,sans-serif}
main{max-width:880px;margin:0 auto}
h1{font-size:20px;margin:0 0 8px}
p{color:rgba(242,239,230,.7);margin:0 0 24px;max-width:70ch}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:6px 12px 6px 0;border-bottom:1px solid rgba(242,239,230,.08);vertical-align:top}
th{color:rgba(242,239,230,.54);font-weight:500}
a{color:inherit}
</style>
<main>
<h1>초상 출처</h1>
<p>게임의 선수 초상은 위키미디어 커먼즈에 자유 라이선스로 공개된 사진을 바탕으로, 구도·조명·옷을
한 가지 형식으로 맞춰 다시 그린 것입니다. 아래는 원본 사진의 저작자와 라이선스입니다
(${String(shown.size)}장). 고쳐 쓴 결과물은 각 원본과 같은 라이선스를 따릅니다.</p>
<table>
<thead><tr><th>선수</th><th>원본 저작자</th><th>라이선스</th><th>출처</th></tr></thead>
<tbody>
${credits}
</tbody>
</table>
</main>
</html>
`,
);

const unfilled = report.filter((r) => r.unfilled);
const failed = report.filter((r) => r.error !== undefined);
console.log(`초상 ${ids.length}장 — 틀을 못 채움 ${unfilled.length} · 실패 ${failed.length}`);
for (const r of unfilled) console.log(`  틀 못 채움  ${r.id} (${r.qid})`);
for (const r of failed) console.log(`  실패       ${r.id} (${r.qid}) — ${r.error}`);
