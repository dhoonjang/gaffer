/**
 * `pnpm lint`의 한 갈래 — 화면의 CSS 클래스 장부를 맞춘다 (apps/web/shared/tokens.css).
 *
 * 화면의 CSS는 전부 전역이다(`apps/web/app/globals.css`가 한 줄로 부른다). 모듈 경계가 없으니
 * 셋은 아무도 모르는 채 쌓인다 — 이 스크립트가 그 셋을 센다.
 *
 * 1. **죽은 클래스** — CSS가 스타일하는데 화면 코드 어디에도 이름이 없다.
 * 2. **없는 클래스** — `className`에 적혔는데 CSS 어디에도 없다. 오타이거나 지운 스타일의 자리다.
 * 3. **뷰 경계** — 두 뷰 파일이 같은 클래스를 맥락 없이(선택자의 맨 앞 덩어리로) 스타일한다.
 *    그러면 globals.css의 부르는 차례가 결과를 정한다. 제 뷰의 맥락 아래에서 남의 조각을
 *    고치는 것(`.live-match-layout .squad-layout`)은 차례가 아니라 선택자가 이기므로 경계
 *    안이고, `.active`처럼 늘 다른 클래스에 붙어서만 서는 상태 클래스는 경계 밖이다.
 *
 * 클래스 이름을 문자열 조각으로 이어 붙이는 자리(`` `form-${r}` ``)는 그 접두사로 읽는다 —
 * `-`로 끝나는 접두사는 무엇이든, 아니면(`` `w${n}` ``) 숫자만 붙는 것으로.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import postcss, { type Rule } from "postcss";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "apps/web");

/** 뷰 파일 — 서로의 클래스를 스타일하지 않는다. 셸·공용·반응형은 뷰를 가로질러 선다 */
const isView = (file: string) => file.startsWith("screens/") || file === "shared/player-card.css";

/**
 * 스타일 없이 이름만 서는 클래스 — 스크립트·e2e가 잡는 손잡이다. 여기에 적힌 것만 2번을
 * 비켜 간다. 새 이름은 이유와 함께 적는다.
 */
const HOOK_ONLY = new Set<string>([
  // e2e가 전술판 자리의 포지션 약칭을 읽는다 (e2e/game.spec.ts)
  "slot-code",
]);

const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".next")) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, ext);
    return ext.test(entry.name) ? [full] : [];
  });

interface Use {
  file: string;
  line: number;
  /** 선택자의 맨 앞 덩어리에 다른 클래스 없이 홀로 섰다 — 맥락 없이 이 클래스를 스타일한다 */
  unscoped: boolean;
}

const CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;

const styled = new Map<string, Use[]>();
for (const full of walk(WEB, /\.css$/)) {
  const file = path.relative(WEB, full);
  if (file === "shared/fonts.css") continue;
  postcss.parse(readFileSync(full, "utf8")).walkRules((rule: Rule) => {
    if (
      rule.parent?.type === "atrule" &&
      /keyframes$/.test((rule.parent as { name: string }).name)
    ) {
      return;
    }
    for (const selector of rule.selectors) {
      // 컴파운드(공백·결합자 사이의 한 덩어리)마다 — `.a.b`의 b는 a에 붙은 상태다
      const compounds = selector.trim().split(/\s*[\s>+~]\s*/);
      compounds.forEach((compound, at) => {
        const names = [...compound.replace(/\([^)]*\)/g, "").matchAll(CLASS)].map((m) => m[1]!);
        for (const name of names) {
          const uses = styled.get(name) ?? [];
          uses.push({
            file,
            line: rule.source?.start?.line ?? 0,
            unscoped: at === 0 && compounds.length === 1 && names.length === 1,
          });
          styled.set(name, uses);
        }
      });
    }
  });
}

const sources = walk(WEB, /\.tsx?$/)
  .filter((f) => !f.endsWith(".d.ts"))
  .map((full) => ({ file: path.relative(WEB, full), text: readFileSync(full, "utf8") }));
/**
 * 코어가 내는 값이 그대로 클래스가 되는 자리(`` `rt-dot ${r.tone}` `` · `conditionBand`)가 있다 —
 * domain·engine의 문자열 리터럴도 화면이 부르는 이름으로 센다.
 */
const coreLiterals = ["packages/domain/src", "packages/engine/src"].flatMap((dir) =>
  walk(path.join(ROOT, dir), /\.ts$/).flatMap((full) =>
    [...readFileSync(full, "utf8").matchAll(/["'`]([A-Za-z_][\w-]*)["'`]/g)].map((m) => m[1]!),
  ),
);
const words = new Set([
  ...sources.flatMap(({ text }) => text.match(/[A-Za-z_][\w-]*/g) ?? []),
  ...coreLiterals,
]);
const prefixes = new Set(
  sources.flatMap(({ text }) => [...text.matchAll(/([A-Za-z_][\w-]*)\$\{/g)].map((m) => m[1]!)),
);
const referenced = (name: string) =>
  words.has(name) ||
  [...prefixes].some(
    (p) =>
      name.startsWith(p) &&
      (p.endsWith("-") ? name.length > p.length : /^\d+$/.test(name.slice(p.length))),
  );

const problems: string[] = [];

// 1. 죽은 클래스
for (const [name, uses] of styled) {
  if (!referenced(name)) {
    const at = uses[0]!;
    problems.push(
      `apps/web/${at.file}:${at.line}  .${name} — 화면 코드 어디에도 없는 클래스다. 지운다`,
    );
  }
}

// 2. 없는 클래스 — className의 고정된 낱말만 센다
for (const { file, text } of sources) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      // 조각을 이어 붙인 이름(`w${n}`)은 접두사 쪽이 센다
      const literal = (m[1] ?? m[2] ?? "").replace(/[\w-]*\$\{[^}]*\}[\w-]*/g, " ");
      for (const name of literal.split(/\s+/)) {
        if (!name || !/^[A-Za-z_][\w-]*$/.test(name) || /-$/.test(name)) continue;
        if (!styled.has(name) && !HOOK_ONLY.has(name)) {
          problems.push(
            `apps/web/${file}:${i + 1}  "${name}" — CSS에 없는 클래스다. 오타이거나 지운 스타일의 자리다`,
          );
        }
      }
    }
  });
}

// 3. 뷰 경계
for (const [name, uses] of styled) {
  const owners = [...new Set(uses.filter((u) => u.unscoped && isView(u.file)).map((u) => u.file))];
  if (owners.length < 2) continue;
  problems.push(
    `.${name} — 뷰 ${owners.join(" · ")}가 맥락 없이 함께 스타일한다. 한 뷰가 갖거나, 함께 쓰면 shared.css로 옮긴다`,
  );
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n✖ CSS 클래스 장부 ${problems.length}건 (scripts/css-classes.ts)`);
  process.exit(1);
}
