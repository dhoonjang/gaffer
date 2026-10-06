import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import next from "@next/eslint-plugin-next";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";

const browserImports = {
  paths: [
    {
      name: "@gaffer/engine",
      allowTypeImports: true,
      message:
        "화면은 엔진을 타입으로만 가져온다 — 값 import는 node:fs를 브라우저 번들에 끌어와 next build를 죽인다. 화면과 코어가 함께 쓰는 순수 규칙은 packages/domain에 두고 엔진이 re-export한다 (AGENTS.md 5장). 서버에서만 도는 모듈이면 eslint.config.js의 예외 목록에 그 파일을 올려라.",
    },
    {
      // agents는 엔진을 값으로 부른다 — 화면이 값으로 가져오면 같은 일이 벌어진다
      name: "@gaffer/agents",
      allowTypeImports: true,
      message:
        "화면은 agents를 타입으로만 가져온다 — 값 import는 엔진을(그리고 node:fs를) 브라우저 번들에 끌어온다. 화면과 서버가 함께 쓰는 순수 값(`TurnOperation` 등)은 packages/domain에 두고 agents가 re-export한다 (AGENTS.md 5장).",
    },
  ],
  patterns: [
    {
      group: [
        "**/game/store",
        "**/game/turn-runner",
        "./store",
        "./turn-runner",
        "**/live-match-server",
        "./live-match-server",
        "**/lorebook-jobs",
        "./lorebook-jobs",
      ],
      allowTypeImports: true,
      message:
        "store.ts·turn-runner.ts는 서버에서만 돈다 — 값으로 부르면 엔진이 딸려 들어와 next build가 죽는다. 화면은 타입만 가져오고, 값이 필요하면 API 라우트를 거쳐라.",
    },
  ],
};
const webScreens = ["chat", "mailbox", "office", "squad", "match"];
/**
 * 엔진 도메인 — **아래에서 위로** 적는다. 한 도메인은 자기보다 앞에 적힌 것만 값으로
 * 부른다. 여러 도메인을 함께 움직이는 흐름은 `app`이 조립한다 (docs/architecture.md §2).
 */
const engineLayers = ["core", "players", "match", "season", "team", "people"];
const layerImports = (owner) => ({
  group: [
    ...engineLayers.slice(engineLayers.indexOf(owner) + 1).map((d) => "**/" + d + "/**"),
    "**/app/**",
  ],
  allowTypeImports: true,
  message:
    "엔진 도메인은 아래 층만 값으로 부른다 (core → players → match → season → people → team → app). 여러 도메인을 함께 움직이는 흐름은 app/workflows에 둔다.",
});
/**
 * 에이전트 폴더 — `config/llm.yml`의 호출 갈래다(Jev 평가 · 기억 · 장면을 쓰는 GM). 층은
 * 아래에서 위로 적고, 같은 층의 폴더끼리는 서로 부르지 않는다. 턴을 엮는 일은 `app`이 한다.
 */
const agentLayers = [["shared"], ["evaluators", "memory"], ["gm"]];
const agentImports = (owner) => {
  const level = agentLayers.findIndex((layer) => layer.includes(owner));
  return {
    group: [
      ...agentLayers[level].filter((d) => d !== owner).map((d) => "**/" + d + "/**"),
      ...agentLayers
        .slice(level + 1)
        .flat()
        .map((d) => "**/" + d + "/**"),
      "**/app/**",
    ],
    allowTypeImports: true,
    message:
      "에이전트 호출은 아래 층만 값으로 부른다 (shared → evaluators·memory → gm → app). 턴을 엮는 일은 app에 둔다.",
  };
};
/**
 * 화면 코드의 디자인 시스템 — 버튼은 `<Button>` 하나, 글리프 아이콘 없음, 산문 부호는 곡선,
 * 색과 글자와 간격은 CSS가 갖는다(인라인 `style`은 좌표와 `--` 변수만).
 */
const GLYPH =
  "[\\u2190-\\u21ff\\u2300-\\u23ff\\u25a0-\\u25ff\\u2600-\\u27bf\\u2b00-\\u2bff\\u00d7]";
const glyphMessage =
  "글리프 아이콘 — 아이콘은 shared/icons.tsx의 24그리드 픽토그램뿐이다 (tokens.css 「숫자와 표기」)";
const LOOK_PROPS =
  "color|background|backgroundColor|border|borderColor|borderWidth|borderRadius|boxShadow|outline|font|fontSize|fontWeight|fontFamily|fontStyle|lineHeight|letterSpacing|margin|marginTop|marginBottom|marginLeft|marginRight|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|gap|zIndex|opacity|filter";
const designSystemSyntax = [
  {
    selector: "JSXOpeningElement[name.name='button']",
    message:
      '맨 <button> — 버튼은 shared/button.tsx의 <Button>으로 선다(type 기본값 "button" · 생김새는 variant). 탭·행·칩처럼 부르는 쪽 클래스가 생김새를 다 가지면 variant="bare".',
  },
  { selector: `JSXText[value=/${GLYPH}/u]`, message: glyphMessage },
  { selector: `Literal[value=/${GLYPH}/u]`, message: glyphMessage },
  { selector: `TemplateElement[value.raw=/${GLYPH}/u]`, message: glyphMessage },
  {
    selector: "JSXText[value=/[\"']/]",
    message:
      "직선 따옴표 — 화면의 인용·대사는 “ ”, 속마음은 ‘ ’, 매체 이름은 『 』다 (tokens.css 「숫자와 표기」)",
  },
  {
    selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
    message:
      "색 리터럴 — 색은 tokens.css의 토큰이고, 화면 코드는 var(--…)나 클래스로 부른다 (tokens.css 「팔레트」)",
  },
  {
    selector: `JSXAttribute[name.name='style'] Property[key.name=/^(${LOOK_PROPS})$/]`,
    message:
      "인라인 style의 생김새 — 색·글자·간격·모서리는 CSS 클래스가 갖는다. 인라인은 좌표·크기와 `--` 변수(데이터가 정하는 값)만 (tokens.css 「팔레트」)",
  },
];
const ownBarrel = (pkg) => ({
  name: "@gaffer/" + pkg,
  allowTypeImports: true,
  message: "패키지 내부는 공개 배럴 대신 소유 모듈을 직접 참조한다.",
});

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      // Next 빌드 산출물 — 기본 `.next` 외에 e2e·스크린샷용 distDir도 함께 (`.next-*`)
      "**/.next/**",
      "**/.next-*/**",
      "**/next-env.d.ts",
      "test-results/**",
      "playwright-report/**",
      ".data/**",
    ],
  },
  js.configs.recommended,
  {
    // 쓰이지 않는 disable 주석도 에러다 — 고친 뒤 남은 예외가 다음 위반을 숨긴다
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  /**
   * 타입 정보를 읽는 규칙군. 버려진 promise · 이벤트에 물린 async · 갈래가 빠진 switch는
   * 타입 없이는 보이지 않고, 실패해도 조용하다.
   */
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // AGENTS.md 5장: any 금지 (불가피하면 unknown + 좁히기)
      "@typescript-eslint/no-explicit-any": "error",
      // `noUncheckedIndexedAccess` 아래에서 `!`는 "이 인덱스는 있다"는 단언이다 — 막으면
      // 같은 단언이 `as`나 쓸모없는 분기로 옮겨 갈 뿐이다
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // 화면이 엔진을 타입으로만 부르는 경계(아래 browserImports)가 import 줄에서 보이게 한다
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // 세이브·카탈로그는 JSON 장부다 — 비운 칸은 키를 지워야 저장 모양이 맞고, Map으로 바꿀 수 없다
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  {
    // async 대역은 던지면 reject가 되어야 실제 구현과 같다
    files: ["**/test/**/*.ts", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    // 스펙은 이름이 tsconfig.json이 아닌 프로젝트에 산다 — 프로젝트 서비스가 찾지 못한다
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      parserOptions: { projectService: false, project: "./tsconfig.e2e.json" },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  comments.recommended,
  {
    rules: {
      // 예외는 이유를 적고 끈다 — `-- 이유`가 없는 disable 주석은 에러다
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: true }],
    },
  },
  /**
   * 화면에만 거는 규칙 — 훅과 Next 규약은 `apps/web` 밖에 걸 곳이 없다.
   * 코어 패키지에 얹으면 React를 쓰지 않는 파일마다 규칙을 헛돌린다.
   *
   * 훅 규칙은 **둘만** 켠다. 플러그인의 `recommended-latest`는 React Compiler
   * 규칙군(`refs`·`purity`·`immutability`·`set-state-in-effect`)까지 들여오는데,
   * 그건 렌더 중 ref 접근과 이펙트 안 setState를 잡는 규칙이라 지금 코드에서
   * 12건이 걸리고(`squad.tsx`·`game-screen.tsx`·`turn-trace.tsx`·`players-panel.tsx`)
   * 전부 컴포넌트 구조를 바꿔야 지워진다. 게이트를 넓히는 일과 화면을 다시 짜는
   * 일은 한 PR에 같이 들어갈 것이 아니다.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    extends: [next.flatConfig.coreWebVitals],
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // 경고로 두면 CI가 초록이라 아무도 읽지 않는다 — 예외는 이유를 적고 끈다
      "react-hooks/exhaustive-deps": "error",
      // App Router 앱이라 `pages/`가 없다 — 규칙이 매번 못 찾겠다고 말한다
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  /**
   * 디자인 시스템 중 화면 코드에 서는 것 (apps/web/shared/tokens.css). CSS 쪽은
   * `stylelint.config.js`가, 클래스 장부는 `scripts/css-classes.ts`가 갖는다.
   */
  {
    files: ["apps/web/**/*.tsx"],
    ignores: ["apps/web/test/**"],
    rules: {
      "no-restricted-syntax": ["error", ...designSystemSyntax],
    },
  },
  {
    // `<Button>` 자신만 맨 `<button>`을 쓴다
    files: ["apps/web/shared/button.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...designSystemSyntax.filter((r) => !r.selector.startsWith("JSXOpeningElement")),
      ],
    },
  },
  /**
   * 화면은 엔진을 **타입으로만** 가져온다 (AGENTS.md 5장).
   *
   * 값 import 하나가 `node:fs`를 브라우저 번들에 끌어와 `next build`를 죽이는데
   * 타입 검사는 통과한다 — 이 규칙이 없으면 CI e2e가 빌드에서 터질 때에야 잡히고
   * 메시지는 원인과 멀다. 그래서 `apps/web` 전체에 기본으로 걸고, 서버에서만 도는
   * 파일을 아래 블록에서 되돌린다. 새로 생긴 폴더가 규칙 밖으로 빠져나가는 쪽보다
   * 서버 전용 파일을 한 줄 늘리는 쪽이 안전하다.
   *
   * 그 서버 전용 모듈 자체도 화면에서 값으로 부르면 같은 일이 벌어진다 — 엔진을
   * 끌고 들어오기 때문이다. 그래서 두 번째 그룹으로 함께 막는다.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", browserImports],
    },
  },
  /**
   * 서버에서만 도는 파일 — 값 import가 정당하다. 라우트 핸들러는 클라이언트가
   * import할 수 없고, `store.ts`·`turn-runner.ts`는 위 그룹이 화면 쪽에서 막는다.
   * (`test/`는 번들이 아니라 vitest가 node에서 돌리고, `next.config.ts`는 빌드 설정이다.)
   */
  {
    files: [
      "apps/web/app/api/**/*.ts",
      "apps/web/game/store.ts",
      "apps/web/game/turn-runner.ts",
      "apps/web/game/lorebook-jobs.ts",
      "apps/web/game/live-match-server.ts",
      "apps/web/test/**/*.ts",
      "apps/web/next.config.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
  /**
   * 화면 — `screens/<화면>`은 공용 조각(`shared/`)만 부르고 다른 화면을 부르지 않는다.
   * 화면을 엮는 일은 `game/`이 한다. 공용 조각과 개발 도구는 화면도 게임 껍데기도 모른다.
   */
  ...["shared", "dev", ...webScreens.map((d) => "screens/" + d)].map((owner) => ({
    files: ["apps/web/" + owner + "/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          ...browserImports,
          patterns: [
            ...browserImports.patterns,
            {
              group: [
                ...webScreens
                  .filter((d) => "screens/" + d !== owner)
                  .map((d) => "**/screens/" + d + "/**"),
                "**/game/**",
                ...(owner === "dev" ? [] : ["**/dev/**"]),
              ],
              allowTypeImports: true,
              message:
                "화면은 공용 조각(shared/)만 부른다. 다른 화면이나 게임 껍데기(game/)가 필요하면 game/이 콜백이나 콘텐츠로 넘긴다.",
            },
          ],
        },
      ],
    },
  })),
  ...engineLayers.map((owner) => ({
    files: ["packages/engine/src/" + owner + "/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { paths: [ownBarrel("engine")], patterns: [layerImports(owner)] },
      ],
    },
  })),
  {
    files: ["packages/engine/src/app/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [ownBarrel("engine")] }],
    },
  },
  ...agentLayers.flat().map((owner) => ({
    files: ["packages/agents/src/" + owner + "/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { paths: [ownBarrel("agents")], patterns: [agentImports(owner)] },
      ],
    },
  })),
  {
    files: ["packages/agents/src/gm/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [ownBarrel("agents")] }],
    },
  },
  /**
   * domain은 모든 컨텍스트가 읽는 **공용 어휘**다 — 폴더는 소유 컨텍스트를 따르지만 서로를
   * 읽는다. 화면 조작의 모양(`app/`)만은 모델이 읽지 않는다.
   */
  {
    files: ["packages/domain/src/**/*.ts"],
    ignores: ["packages/domain/src/kernel/**", "packages/domain/src/index.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [ownBarrel("domain")],
          patterns: [
            {
              group: ["**/app/**"],
              allowTypeImports: true,
              message: "domain의 모델은 화면 조작의 모양(app/)을 읽지 않는다.",
            },
          ],
        },
      ],
    },
  },
  /**
   * 실시간 경기 엔진(`packages/sim/src/live`)은 브라우저가 굴린 결과를 서버가 **같은 코드로
   * 다시 굴려** 검증한다 — 두 쪽이 비트까지 같아야 한다 (docs/match/live-match.md §8.2).
   * 초월 `Math.*`는 ECMAScript가 결과를 정하지 않아 JS 엔진마다 마지막 비트가 다를 수 있고,
   * `**`는 `Math.pow`와 같은 구현이다. 그 자리는 `live/dmath.ts`의 결정적 구현이 맡는다.
   * `Math.sqrt`·`floor`·`abs`·`min`·`max`·`sign`·`fround`·`imul`은 IEEE가 결과를 정하므로 남긴다.
   */
  {
    files: [
      "packages/sim/src/live/**/*.ts",
      "packages/sim/src/load.ts",
      "packages/domain/src/core/dmath.ts",
      "packages/domain/src/core/log-curves.ts",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        ...[
          "exp",
          "expm1",
          "log",
          "log1p",
          "log2",
          "log10",
          "sin",
          "cos",
          "tan",
          "asin",
          "acos",
          "atan",
          "atan2",
          "sinh",
          "cosh",
          "tanh",
          "asinh",
          "acosh",
          "atanh",
          "pow",
          "hypot",
          "cbrt",
          "random",
        ].map((property) => ({
          object: "Math",
          property,
          message: `Math.${property}은 JS 엔진마다 마지막 비트가 다를 수 있다 — 실시간 경기는 서버가 같은 코드로 다시 굴려 검증하므로 packages/sim/src/live/dmath.ts의 결정적 구현(dexp·dlog·dsigmoid·dhypot)을 쓴다 (docs/match/live-match.md §8.2).`,
        })),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator='**']",
          message:
            "`**`는 Math.pow와 같은 구현이라 JS 엔진마다 결과가 다를 수 있다 — 정수 거듭제곱은 곱셈으로 풀고, 그 밖은 packages/sim/src/live/dmath.ts(dexp·dlog)로 쓴다 (docs/match/live-match.md §8.2).",
        },
        {
          selector: "AssignmentExpression[operator='**=']",
          message:
            "`**=`는 Math.pow와 같은 구현이라 JS 엔진마다 결과가 다를 수 있다 — 정수 거듭제곱은 곱셈으로 풀고, 그 밖은 packages/sim/src/live/dmath.ts(dexp·dlog)로 쓴다 (docs/match/live-match.md §8.2).",
        },
      ],
    },
  },
);
