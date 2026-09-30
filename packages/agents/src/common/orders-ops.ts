import type { GameToolSpec } from "@story-fm/llm";

/** 한 명령을 한 턴에 부를 수 있는 수 — 같은 명령을 셋 부를 일은 있어도 여덟은 없다 */
export const OPS_PER_COMMAND = 4;

export type OpsInput = Record<string, unknown[]>;

/**
 * 명령마다 다른 상한 — **규칙이 정한 수가 있는 자리는 그 수를 쓴다.** 교체는 다섯,
 * 개인 지시는 열한 자리, 지역 플랜은 둘. 적지 않은 명령은 `OPS_PER_COMMAND`다.
 */
export type OpsCaps = Readonly<Record<string, number>>;

/** 남은 것과 잘린 수 — 자르는 자리가 곧 그 사실을 아는 유일한 자리다 */
export interface ParsedOps {
  ops: OpsInput;
  /** 상한에 걸려 버린 수 — 명령 이름별. 자른 것이 없으면 빈 객체 */
  truncated: Record<string, number>;
}

/**
 * 모델이 낸 `ops` — 목록에 있는 이름의 배열만 남긴다. 검증은 적용 때 도구가 한다.
 *
 * **자른 수를 함께 낸다.** mock/기록 입력은 스키마 디코더를 거치지 않으므로
 * 디코더가 막아 주지 않고, 넘겨 온 것을 자르는 것은 여기다. 그 사실이 여기서 끝나면
 * 감독은 교체를 여섯 부르고 다섯만 걸린 판 위에 다음 판단을 쌓는다 — `applyOps`가 이
 * 수를 한 줄로 되돌린다.
 */
export function parseOps(raw: unknown, names: readonly string[], caps: OpsCaps = {}): ParsedOps {
  const ops: OpsInput = {};
  const truncated: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null) return { ops, truncated };
  for (const name of names) {
    const value = (raw as Record<string, unknown>)[name];
    if (!Array.isArray(value) || value.length === 0) continue;
    const cap = caps[name] ?? OPS_PER_COMMAND;
    ops[name] = value.slice(0, cap);
    if (value.length > cap) truncated[name] = value.length - cap;
  }
  return { ops, truncated };
}

/**
 * 순서대로 적용한다 — **동기 도구만**이다. 실패도 감독에게 돌아간다(반려 문장이 곧
 * 결과다). 순서는 `names`가 정한다: 답할 것을 먼저, 새로 여는 것을 뒤에.
 */
export function applyOps(
  specs: ReadonlyMap<string, GameToolSpec>,
  orders: OpsOrders,
  names: readonly string[],
  notes: string[],
): { applied: number; rejected: number } {
  let applied = 0,
    rejected = 0;
  const ops = orders.ops;
  for (const name of names) {
    const spec = specs.get(name);
    const inputs = ops[name];
    if (!spec || !inputs) continue;
    for (const input of inputs) {
      const result = spec.handle(input);
      if (result instanceof Promise) throw new Error(`${name}: 받아쓰기 적용은 동기 도구만 부른다`);
      if (result.ok) applied++;
      else rejected++;
      if (result.message) notes.push(result.message);
    }
    // 자른 줄은 그 명령이 돌려준 답들 바로 뒤다 — 자리가 곧 무엇이 잘렸는지다
    const dropped = orders.truncated?.[name];
    if (dropped) notes.push(truncatedNote(inputs.length, dropped));
  }
  if (orders.unresolved) notes.push(unresolvedNote(orders.unresolved));
  return { applied, rejected };
}

/** 옮기지 못한 말이 감독에게 돌아가는 한 줄 — **문구는 여기 하나다** */
export function unresolvedNote(text: string): string {
  return `옮기지 못한 지시: “${text}”`;
}

/**
 * 상한에 잘린 지시가 감독에게 돌아가는 한 줄 — **문구는 여기 하나다.**
 *
 * 어느 명령인지는 이름으로 적지 않는다. 코어의 답은 명령 이름을 입에 담지 않고
 * (agents.md §0), 이 줄은 그 명령이 돌려준 답들 바로 뒤에 서므로 자리가 곧 무엇인지다.
 */
export function truncatedNote(kept: number, dropped: number): string {
  return `한 번에 ${kept}건까지 걸립니다 — 나머지 ${dropped}건은 걸지 못했습니다`;
}

/** 값이 있을 때만 서는 태그 블록 — 세 해석기의 입력이 같은 모양으로 조립된다 */
export function tagged(tag: string, body: string): string[] {
  return body.trim().length > 0 ? [`<${tag}>`, body, `</${tag}>`] : [];
}

/** 받아쓰기 해석기가 내는 것 — 부를 명령과 그 인자, 그리고 옮기지 못한 말 */
export interface OpsOrders {
  ops: OpsInput;
  /** 상한에 걸려 자른 수 — 명령 이름별. `applyOps`가 한 줄로 되돌린다 */
  truncated?: Readonly<Record<string, number>>;
  unresolved?: string;
}

/** Normalization for scripted instruction fixtures and legacy recorded reports. */
export function parseOrdersReport(
  report: { ops?: unknown; unresolved?: string },
  names: readonly string[],
  caps: OpsCaps = {},
): OpsOrders {
  const { ops, truncated } = parseOps(report.ops, names, caps);
  return {
    ops,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    ...(report.unresolved ? { unresolved: report.unresolved } : {}),
  };
}
