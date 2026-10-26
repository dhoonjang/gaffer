import { build, type Plugin } from "esbuild";
import { resolve } from "node:path";
import { simBuildId } from "../../../scripts/sim-build";

/**
 * 운영 서버를 이미지 빌드 때 ESM 묶음 둘로 굳힌다 — 기동마다 TS 변환과 수천 번의 모듈
 * 해석을 치르지 않게. 워크스페이스 소스만 묶고 npm 패키지는 node_modules에서 그대로 읽는다.
 *
 * 실행 Worker는 `runner.ts`가 부르는 이름(`worker-bootstrap.mjs`)으로 main 옆에 둔다.
 * `dist/`는 `src/`와 깊이가 같아 `import.meta.url` 기준 상대 경로(마이그레이션 등)가 그대로 맞는다.
 * 시뮬 빌드 해시는 소스 트리를 읽어 만드는 값이라 여기서 굳혀 넣는다.
 */
const api = resolve(import.meta.dirname, "..");

/**
 * 워크스페이스 패키지는 소스 진입점으로 곧장 묶는다 — 이미지 빌드는 api의 의존성만 깔아
 * `apps/web` 아래에서 부르는 `@gaffer/*`가 node_modules로는 풀리지 않는다.
 */
const resolution: Plugin = {
  name: "workspace-and-npm",
  setup(b) {
    b.onResolve({ filter: /^@gaffer\/[a-z-]+$/ }, (args) => ({
      path: resolve(api, "../../packages", args.path.slice("@gaffer/".length), "src/index.ts"),
    }));
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@/") ? undefined : { path: args.path, external: true },
    );
  },
};

await build({
  absWorkingDir: api,
  entryPoints: {
    main: resolve(api, "src/main.ts"),
    "worker-bootstrap": resolve(api, "src/worker-entry.ts"),
  },
  outdir: resolve(api, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [resolution],
  define: { "process.env.GAFFER_SIM_BUILD_ID": JSON.stringify(simBuildId()) },
  logLevel: "warning",
});
