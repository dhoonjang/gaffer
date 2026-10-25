interface Context {
  request: Request;
  env: { API_ORIGIN: string; APP_ORIGIN: string };
}
export async function onRequest({ request, env }: Context): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  try {
    const upstream = new URL(env.API_ORIGIN);
    if (upstream.protocol !== "https:" || upstream.username || upstream.password)
      throw new Error("Invalid API origin");
    const incoming = new URL(request.url);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;
    const forwarded = new Headers(request.headers);
    forwarded.delete("host");
    forwarded.delete("x-forwarded-host");
    forwarded.delete("x-forwarded-proto");
    forwarded.delete("x-forwarded-for");
    const response = await fetch(upstream, {
      method: request.method,
      headers: forwarded,
      redirect: "manual",
      ...(["GET", "HEAD"].includes(request.method) ? {} : { body: request.body }),
      signal: AbortSignal.timeout(70_000),
    });
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") headers.set(key, value);
    });
    for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    headers.set("Cache-Control", "no-store");
    headers.delete("CDN-Cache-Control");
    headers.delete("Cloudflare-CDN-Cache-Control");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json({ error: "API에 연결하지 못했습니다" }, { status: 502, headers });
  }
}
