/** Values retain their source; a model chooses references, never writes numbers or text. */
interface SourceNumber {
  value: number;
  text: string;
  start: number;
  end: number;
}

const SMALL_UNITS: Readonly<Record<string, number>> = { 십: 10, 백: 100, 천: 1_000 };
const LARGE_UNITS: Readonly<Record<string, number>> = {
  만: 10_000,
  억: 100_000_000,
  조: 1_000_000_000_000,
};

function koreanNumber(text: string): number | undefined {
  for (const group of text.matchAll(/\d[\d,]*/g)) {
    if (group[0].includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(group[0])) return undefined;
  }
  const compact = text.replaceAll(/[,\s]/g, "");
  const pieces = compact.match(/\d+(?:\.\d+)?|[십백천만억조]/g);
  if (!pieces || pieces.join("") !== compact) return undefined;
  let result = 0;
  let group = 0;
  let groupSpecified = false;
  let pending: number | undefined;
  let lastLarge = Number.POSITIVE_INFINITY;
  let lastSmall = Number.POSITIVE_INFINITY;
  for (const piece of pieces) {
    if (/^\d/.test(piece)) {
      if (pending !== undefined) return undefined;
      pending = Number(piece);
    } else if (SMALL_UNITS[piece]) {
      const unit = SMALL_UNITS[piece];
      if (unit >= lastSmall) return undefined;
      group += (pending ?? 1) * unit;
      groupSpecified = true;
      pending = undefined;
      lastSmall = unit;
    } else {
      const unit = LARGE_UNITS[piece]!;
      if (unit >= lastLarge) return undefined;
      const coefficient = pending === undefined && !groupSpecified ? 1 : group + (pending ?? 0);
      result += coefficient * unit;
      group = 0;
      groupSpecified = false;
      pending = undefined;
      lastLarge = unit;
      lastSmall = Number.POSITIVE_INFINITY;
    }
  }
  const value = result + group + (pending ?? 0);
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

export function sourceNumbers(said: string): SourceNumber[] {
  const result: SourceNumber[] = [];
  const expression =
    /[+-]?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s*[십백천만억조](?:\s*\d(?:[\d,]*\d)?(?:\.\d+)?)?)*/g;
  for (const match of said.matchAll(expression)) {
    const text = match[0];
    const sign = text.startsWith("-") ? -1 : 1;
    const unsigned = text.replace(/^[+-]/, "");
    const parsed = koreanNumber(unsigned);
    if (parsed === undefined) continue;
    result.push({ value: sign * parsed, text, start: match.index, end: match.index + text.length });
  }
  return result;
}

/** Whitespace and punctuation boundaries keep exact original phrases, including Korean. */
export function sourceBoundaries(said: string): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of said.matchAll(/[^\s,;.!?。！？]+/gu)) {
    starts.push(match.index);
    ends.push(match.index + match[0].length);
  }
  return { starts, ends };
}
