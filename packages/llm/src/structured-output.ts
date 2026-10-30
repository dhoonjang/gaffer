/**
 * 출력 스키마로 받은 답을 읽는다 — **제공자 셋이 같은 자리다** (models.md §3-2).
 *
 * 셋 다 스키마에 맞춘 JSON을 본문 텍스트로 돌려준다. 어댑터는 여기까지고, 그 객체가
 * 스키마를 지키는지는 부르는 쪽의 Zod가 본다 — 제공자가 스키마를 얼마나 강제하는지가
 * 다르기 때문이다(OpenAI는 `strict: false`라 안내일 뿐이다).
 *
 * 최상위는 객체여야 한다(`JsonObjectSchema`). 잘린 응답의 반쪽 JSON, 거절 문장, 산문은 전부
 * `null`이다 — 그것이 "산출이 오지 않았다"의 유일한 신호다.
 */
export function parseOutput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** JSON 문자열의 한 글자 이스케이프 — `\uXXXX`는 따로 푼다 */
const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * 출력 스키마로 받는 답의 **문자열 칸 하나를 흐르는 대로** 푼다 — 본문이 JSON이라 델타는
 * 따옴표·이스케이프째 온다. 그 칸의 값만 `emit`에 흘리고, 칸이 닫히면 나머지는 버린다.
 *
 * 조각 경계에 걸린 이스케이프와 서로게이트의 앞 반쪽은 다음 조각까지 들고 있다 — 짝 잃은
 * 반쪽은 저장(jsonb)이 받지 않는다. 산출은 여전히 끝난 본문을 `parseOutput`이 읽는다.
 */
export function streamOutputField(
  key: string,
  emit: (delta: string) => void,
): (delta: string) => void {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  let phase: "seek" | "value" | "closed" = "seek";
  let raw = "";
  let held = "";
  return (delta: string) => {
    if (phase === "closed") return;
    raw += delta;
    if (phase === "seek") {
      const found = opener.exec(raw);
      if (!found) return;
      raw = raw.slice(found.index + found[0].length);
      phase = "value";
    }
    let out = held;
    held = "";
    let at = 0;
    while (at < raw.length) {
      const ch = raw[at]!;
      if (ch === '"') {
        phase = "closed";
        break;
      }
      if (ch !== "\\") {
        out += ch;
        at += 1;
        continue;
      }
      const escape = raw[at + 1];
      if (escape === undefined) break;
      if (escape === "u") {
        const hex = raw.slice(at + 2, at + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        at += 6;
        continue;
      }
      out += JSON_ESCAPES[escape] ?? escape;
      at += 2;
    }
    raw = phase === "closed" ? "" : raw.slice(at);
    const last = out.charCodeAt(out.length - 1);
    if (phase !== "closed" && last >= 0xd800 && last <= 0xdbff) {
      held = out.slice(-1);
      out = out.slice(0, -1);
    }
    if (out.length > 0) emit(out);
  };
}

/**
 * 스키마의 **선택 속성 수** — `properties`에 있으되 `required`에 없는 자리를 스키마 전체에서
 * 센다. 스키마를 문법으로 펼치는 제공자는 이 수에 한도를 둔다(Anthropic 24 — 2026-09 실측,
 * `ANTHROPIC_OUTPUT_SCHEMA_LIMITS`). 산출을 세우는 쪽이 제공자를 고를 때 그 문을 지나는지
 * 미리 아는 자리다 — 실호출로 400을 맞아 알아내지 않는다 (models.md §3-2).
 */
export function countOptionalProperties(schema: unknown): number {
  if (Array.isArray(schema))
    return schema.reduce<number>((sum, n) => sum + countOptionalProperties(n), 0);
  if (schema === null || typeof schema !== "object") return 0;
  const node = schema as Record<string, unknown>;
  let count = 0;
  const properties = node.properties;
  if (properties !== null && typeof properties === "object") {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (!required.has(name)) count += 1;
      count += countOptionalProperties(sub);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties") continue;
    count += countOptionalProperties(value);
  }
  return count;
}
