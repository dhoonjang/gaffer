import { readFileSync } from "node:fs";
import path from "node:path";

import postcss from "postcss";
import stylelint from "stylelint";

/**
 * 디자인 시스템의 **금지** — 값과 그 뜻은 `apps/web/shared/tokens.css` 하나가 갖고, 이 파일은
 * 그것을 읽어 허용 목록을 짓는다. 토큰을 더하거나 바꾸면 규칙이 따라오므로 여기에 값을 다시
 * 적지 않는다. 메시지는 tokens.css의 절 이름을 가리킨다.
 *
 * 예외는 `/* stylelint-disable-next-line <규칙> -- 이유 *\/`로만 선다 — 이유 없는 disable과
 * 아무것도 끄지 않는 disable은 에러다.
 */

const {
  createPlugin,
  utils: { report, ruleMessages },
} = stylelint;

const TOKENS = "apps/web/shared/tokens.css";
const doc = (section) => `(tokens.css ${section})`;

/** tokens.css의 `:root` 선언 — 이름 → 값 */
const tokens = new Map();
postcss.parse(readFileSync(path.join(import.meta.dirname, TOKENS), "utf8")).walkDecls((decl) => {
  if (decl.parent?.selector === ":root" && decl.prop.startsWith("--")) {
    tokens.set(decl.prop, decl.value.trim());
  }
});
/** 접두사로 고른 토큰의 이름들 */
const named = (prefix) => [...tokens.keys()].filter((name) => name.startsWith(prefix));
/** 접두사로 고른 토큰의 값들 */
const valuesOf = (prefix) => named(prefix).map((name) => tokens.get(name));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `var(--fs-sm)`처럼 그 접두사의 토큰 하나를 부르는 값 */
const varOf = (prefix) => new RegExp(`^var\\((${named(prefix).map(escape).join("|")})\\)$`);
const px = (name) => {
  const value = tokens.get(name);
  if (!value?.endsWith("px")) throw new Error(`${TOKENS}: ${name}이 px 값이 아니다`);
  return Number.parseFloat(value);
};
/** 간격의 단위 — 그 배수만 선다. `--sp-hair`는 토큰으로만 부른다 */
const SPACING_UNIT = px("--sp-1");

/** 선언 값에서 문자열·주석을 걷어 낸다 — `content: "#1"` 같은 글자가 색으로 읽히지 않게 */
const bare = (value) => value.replace(/"[^"]*"|'[^']*'/g, '""').replace(/\/\*.*?\*\//g, "");

const rule = (name, message, check) => {
  const ruleName = `gaffer/${name}`;
  const messages = ruleMessages(ruleName, { rejected: message });
  const ruleFunction = (primary) => (root, result) => {
    if (!primary) return;
    root.walkDecls((decl) => {
      const found = check(decl);
      if (found) {
        report({
          ruleName,
          result,
          node: decl,
          word: found === true ? decl.value : found,
          message: messages.rejected(found === true ? decl.value : found),
        });
      }
    });
  };
  ruleFunction.ruleName = ruleName;
  ruleFunction.messages = messages;
  ruleFunction.meta = { url: TOKENS };
  return createPlugin(ruleName, ruleFunction);
};

/**
 * 색은 토큰으로만 — hex · 숫자로 쓴 rgb()/hsl() · 이름 붙은 색. `rgba(var(--pos-fw), .18)`처럼
 * 채널을 토큰이 쥔 꼴은 색 리터럴이 아니고, `mask-image`의 불투명 스톱은 색이 아니라 알파다.
 */
const NAMED_COLOR =
  /(?<![\w-])(white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|gold|pink|navy|teal|lime|maroon|olive|aqua|fuchsia)(?![\w-])/i;
const colorTokens = rule(
  "color-tokens",
  (value) => `색 리터럴 "${value}" — 색은 토큰으로만 선다 ${doc("「팔레트」")}`,
  (decl) => {
    if (/^(-webkit-)?mask/.test(decl.prop)) return false;
    const value = bare(decl.value);
    const hex = value.match(/#[0-9a-f]{3,8}\b/i);
    if (hex) return hex[0];
    const fn = value.match(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?!var\()[^)]*\)/i);
    if (fn) return fn[0];
    if (/^(font|grid|transition|animation|white-space|will-change|content)/.test(decl.prop)) {
      return false;
    }
    const named = value.match(NAMED_COLOR);
    return named ? named[0] : false;
  },
);

/**
 * 간격은 `--sp-1`의 배수 — 그 밖의 한 칸(`--sp-hair`)은 토큰으로만 부른다. `-1px`은 간격이
 * 아니라 헤어라인 겹침이다(탭 밑줄이 줄 밑선 위에 앉는다).
 */
const SPACING =
  /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline)(-start|-end)?)?$/;
const spacingScale = rule(
  "spacing-scale",
  (value) =>
    `간격 ${value} — 간격은 ${SPACING_UNIT}px의 배수이거나 var(--sp-*)다 ${doc("「표면·간격」")}`,
  (decl) => {
    if (!SPACING.test(decl.prop)) return false;
    for (const m of bare(decl.value).matchAll(/(?<![\w.-])-?(\d+(?:\.\d+)?)px/g)) {
      if (m[0] !== "-1px" && Number(m[1]) % SPACING_UNIT !== 0) return m[0];
    }
    for (const m of decl.value.matchAll(/var\((--sp-[\w-]+)\)/g)) {
      if (!tokens.has(m[1])) return m[0];
    }
    return false;
  },
);

/** 시간은 토큰으로만 — `0s`는 "없음"이라 숫자로 남는다 */
const motionTokens = rule(
  "motion-tokens",
  (value) =>
    `시간 ${value} — 모션은 --dur-* · --loop-* · --ease · --panel-anim뿐이다 ${doc("「모션」")}`,
  (decl) => {
    if (!/^(transition|animation)(-duration|-delay)?$/.test(decl.prop)) return false;
    for (const m of bare(decl.value).matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)) {
      if (Number(m[1]) !== 0) return m[0];
    }
    return false;
  },
);

/**
 * 컨테이너 테두리 금지 — 네 변을 한꺼번에 긋는 선은 투명할 때만(자리만 잡아 두는 선) 선다.
 * 구획은 밝기와 간격, 조작은 면과 키 컬러가 가른다. 한 변의 헤어라인·레일은 따로 선다.
 */
const noContainerBorder = rule(
  "no-container-border",
  (value) =>
    `네 변 테두리 "${value}" — 구획은 면의 밝기, 조작은 면과 키 컬러로 가른다 ${doc("「조작」 · 「표면·간격」")}`,
  (decl) => {
    if (!/^(border|outline)$/.test(decl.prop)) return false;
    const value = decl.value.trim();
    if (/^(none|0|0px)$/.test(value) || /\btransparent\b/.test(value)) return false;
    if (decl.prop === "outline" && /^(none|0)/.test(value)) return false;
    return true;
  },
);

/** 글리프 아이콘 금지 — 화살표·체크·별·삼각형·이모지는 `icons.tsx`의 픽토그램으로 */
const GLYPH =
  /[\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\u{1f000}-\u{1faff}]/u;
const noGlyphContent = rule(
  "no-glyph-content",
  (value) =>
    `글리프 ${value} — 아이콘은 icons.tsx의 24그리드 픽토그램뿐이다 ${doc("「숫자와 표기」")}`,
  (decl) => {
    if (decl.prop !== "content") return false;
    const glyph = decl.value.match(GLYPH);
    return glyph ? glyph[0] : false;
  },
);

const allowed = (...patterns) => patterns;
const WIDTHS = named("--bp-")
  .filter((name) => name !== "--bp-short")
  .map(px);

/**
 * 그림자는 셋뿐 — 포커스 링, `--pop`의 그림자, 그리고 면 **안쪽**에 긋는 한 줄(레일·밑줄·
 * 속 테두리)과 점을 바탕에서 떼어 내는 컷 링. 겹쳐 쓸 때는 쉼표로 잇는다.
 */
const SHADOW_PART = String.raw`(var\(--ring\)|var\(--shadow-pop\)|inset( -?\d+(px)?){2,4} var\(--[\w-]+\)|0 0 0 \d+px var\(--[\w-]+\))`;
const BOX_SHADOW = new RegExp(`^${SHADOW_PART}(\\s*,\\s*${SHADOW_PART})*$`);

export default {
  plugins: [colorTokens, spacingScale, motionTokens, noContainerBorder, noGlyphContent],
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  ignoreFiles: ["**/node_modules/**", "**/.next/**", "**/.next-*/**", "apps/web/shared/fonts.css"],
  rules: {
    "gaffer/color-tokens": true,
    "gaffer/spacing-scale": true,
    "gaffer/motion-tokens": true,
    "gaffer/no-container-border": true,
    "gaffer/no-glyph-content": true,

    "selector-disallowed-list": [
      [/:root/],
      { message: () => `:root는 ${TOKENS}에만 선다 — 토큰은 한 곳에 모인다` },
    ],
    "declaration-no-important": [
      true,
      {
        message:
          "!important — 캐스케이드 순서(globals.css)로 이긴다. 정말 필요하면 이유를 단 disable로",
      },
    ],
    "declaration-property-value-allowed-list": [
      {
        // 눈금 밖은 둘 — 부모에 매인 em, 그리고 칸 폭에 매인 clamp(전술판 칩). 터치 바닥 16px은 disable로
        "font-size": allowed(
          varOf("--fs-"),
          /^\d*\.?\d+em$/,
          /^clamp\(\d+(\.\d+)?px, \d*\.?\d+cqw, \d+(\.\d+)?px\)$/,
          "inherit",
        ),
        // 굵기·자간은 숫자를 그대로 적어도 된다 — 토큰의 값이기만 하면
        "font-weight": allowed(...valuesOf("--fw-"), varOf("--fw-"), "inherit"),
        "font-style": allowed("normal", "inherit"),
        "font-family": allowed(varOf("--font-"), "inherit"),
        "letter-spacing": allowed(...valuesOf("--ls-"), varOf("--ls-"), "inherit"),
        "line-height": allowed(varOf("--lh-"), "0", "inherit"),
        "/^border(-(top|bottom)-(left|right)|-(start|end)-(start|end))?-radius$/": allowed(
          new RegExp(`^((var\\((${named("--r-").map(escape).join("|")})\\)|0|50%)(\\s+|$))+$`),
          "inherit",
        ),
        // 한 조각 안의 겹침(0–9)만 숫자다 — 화면 단위의 층은 「층」의 목록에서 고른다
        "z-index": allowed(varOf("--z-"), /^-?\d$/, "auto"),
        "box-shadow": allowed("none", BOX_SHADOW),
      },
      {
        message: (property, value) =>
          `${property}: ${value} — 이 속성은 tokens.css의 눈금 안에서만 고른다 ${doc("「서체」 · 「글자 눈금」 · 「모서리」 · 「층」")}`,
      },
    ],
    "media-feature-name-value-allowed-list": [
      {
        // 폭은 토큰이 경계의 시작 — min은 그대로, max는 1px 아래. 세로(--bp-short)는 그 반대로
        // 토큰이 경계의 끝이다 — max가 그대로, min이 1px 위
        "max-width": WIDTHS.map((w) => `${w - 1}px`),
        "min-width": WIDTHS.map((w) => `${w}px`),
        "max-height": [`${px("--bp-short")}px`],
        "min-height": [`${px("--bp-short") + 1}px`],
      },
      {
        message: (feature, value) =>
          `@media (${feature}: ${value}) — 화면 눈금은 --bp-*뿐이다 ${doc("「화면 눈금」")}`,
      },
    ],
  },
  overrides: [
    {
      files: [TOKENS],
      rules: {
        "selector-disallowed-list": null,
        "gaffer/color-tokens": null,
      },
    },
  ],
};
