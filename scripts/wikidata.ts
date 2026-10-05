export const UA = "gaffer-seed/1.0 (https://github.com/dhoonjang/gaffer)";
export type SparqlRow = Record<string, { value: string } | undefined>;
function bindingsOf(body: unknown): SparqlRow[] {
  if (typeof body !== "object" || body === null || !("results" in body))
    throw new Error("Invalid SPARQL response");
  const results = body.results;
  if (
    typeof results !== "object" ||
    results === null ||
    !("bindings" in results) ||
    !Array.isArray(results.bindings)
  )
    throw new Error("Invalid SPARQL bindings");
  return results.bindings.map((row: unknown) => {
    if (typeof row !== "object" || row === null) throw new Error("Invalid SPARQL row");
    const entries = Object.entries(row).map(([key, field]: [string, unknown]) => {
      if (
        typeof field !== "object" ||
        field === null ||
        !("value" in field) ||
        typeof field.value !== "string"
      )
        throw new Error("Invalid SPARQL value");
      return [key, { value: field.value }] as const;
    });
    return Object.fromEntries(entries);
  });
}
export async function sparql(query: string): Promise<SparqlRow[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch("https://query.wikidata.org/sparql", {
        method: "POST",
        headers: {
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
        },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return bindingsOf(await res.json());
    } catch {
      /* Retry transient transport and malformed responses. */
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  throw new Error("위키데이터가 다섯 번 다 답하지 않았다");
}
