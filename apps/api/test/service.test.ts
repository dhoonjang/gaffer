import { postgresOptions } from "../src/postgres";
import { Service } from "../src/service";
import { maintenance } from "../src/maintenance";
import { hash, encode } from "../src/objects";
import { onRequest } from "../../../infra/cloudflare/functions/api/[[path]]";
import { vi } from "vitest";
import { Usage } from "../src/usage";
import { Backup } from "../src/backup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config";
import { database, type Database } from "../src/database";
import { objectStore } from "../src/objects";
import { Jobs } from "../src/jobs";
import { Auth, type GoogleClaims, type GoogleOidc } from "../src/auth";

describe("durable service boundary", () => {
  let directory: string;
  let db: Database;
  let jobs: Jobs;
  const owner = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "gaffer-service-test-"));
    const c = configuration({ GAFFER_MODE: "local", GAFFER_DATA_DIR: directory });
    db = await database(c);
    jobs = new Jobs(db, objectStore(c));
    await db.query("INSERT INTO private.members(id,email_hash) VALUES($1,$2),($3,$4)", [
      owner,
      owner,
      other,
      other,
    ]);
  });
  afterAll(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("requires a real session locally by default and revokes it on logout", async () => {
    const c = configuration({ GAFFER_DATA_DIR: directory });
    const service = new Service(c, db, jobs.objects);
    for (const path of ["/api/auth/me", "/api/games", "/api/admin/catalog", "/api/lab"])
      await expect(
        service.handle(
          new Request(`${c.APP_ORIGIN}${path}`, {
            headers: { cookie: `gaffer_local=${owner}` },
          }),
        ),
      ).rejects.toMatchObject({ status: 401 });
    const token = randomUUID();
    await db.query(
      "INSERT INTO private.sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hash(token), owner],
    );
    const headers = { cookie: `gaffer_session=${token}` };
    const response = await service.handle(new Request(`${c.APP_ORIGIN}/api/auth/me`, { headers }));
    expect(await response.json()).toMatchObject({ id: owner, local: false });
    await expect(
      service.handle(
        new Request(`${c.APP_ORIGIN}/api/auth/logout`, {
          method: "POST",
          headers,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await service.handle(
          new Request(`${c.APP_ORIGIN}/api/auth/logout`, {
            method: "POST",
            headers: { ...headers, origin: c.APP_ORIGIN },
          }),
        )
      ).status,
    ).toBe(200);
    await expect(
      service.handle(new Request(`${c.APP_ORIGIN}/api/auth/me`, { headers })),
    ).rejects.toMatchObject({ status: 401 });
    const development = new Auth(configuration({ GAFFER_AUTH_MODE: "development" }), db);
    expect((await development.identity(new Request(c.APP_ORIGIN))).role).toBe("admin");
    expect(() =>
      configuration({ GAFFER_MODE: "production", GAFFER_AUTH_MODE: "development" }),
    ).toThrow("Google authentication");
  });
  it("signs in with Google only after state, nonce, a verified email and an invite or operator email match", async () => {
    await expect(
      new Auth(configuration({ GAFFER_DATA_DIR: directory }), db).start(
        new Request("http://localhost:5173/api/auth/start", { method: "POST", body: "{}" }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    const c = configuration({
      GAFFER_DATA_DIR: directory,
      GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret",
      SESSION_KEY: Buffer.alloc(32, 7).toString("base64"),
      EMAIL_HASH_KEY: "email-key",
      ADMIN_EMAILS: " Owner@Example.com ",
    });
    let claims: GoogleClaims = { sub: "g-owner", email: "owner@example.com", email_verified: true };
    const exchanged: string[] = [];
    const google: GoogleOidc = {
      exchange: (code, verifier, redirectUri) => {
        exchanged.push(`${code}|${redirectUri}|${verifier.length}`);
        return Promise.resolve("id-token");
      },
      verify: () => Promise.resolve(claims),
    };
    const auth = new Auth(c, db, google);
    const begin = async (invite = "") => {
      const response = await auth.start(
        new Request(`${c.APP_ORIGIN}/api/auth/start`, {
          method: "POST",
          body: JSON.stringify({ invite }),
        }),
      );
      const url = new URL(((await response.json()) as { url: string }).url);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      return {
        url,
        cookie,
        state: url.searchParams.get("state")!,
        nonce: url.searchParams.get("nonce")!,
      };
    };
    const finish = (state: string, cookie: string) =>
      auth.callback(
        new Request(`${c.APP_ORIGIN}/api/auth/callback?code=c1&state=${state}`, {
          headers: { cookie },
        }),
      );
    const sessionOf = (response: Response) =>
      response.headers
        .getSetCookie()
        .find((x) => x.startsWith("gaffer_session=") && !x.startsWith("gaffer_session=;"))
        ?.split(";")[0];
    const errorOf = (response: Response) =>
      new URLSearchParams(new URL(response.headers.get("location")!).hash.slice(1)).get(
        "login_error",
      );

    let attempt = await begin();
    expect(`${attempt.url.origin}${attempt.url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(attempt.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(attempt.url.searchParams.get("redirect_uri")).toBe(`${c.APP_ORIGIN}/api/auth/callback`);
    expect(attempt.url.searchParams.get("scope")).toBe("openid email");
    // A forged state never reaches the code exchange
    expect(errorOf(await finish("forged", attempt.cookie))).toBeTruthy();
    expect(exchanged).toEqual([]);
    // An ID token minted for another login (nonce mismatch) is refused
    claims = { ...claims, nonce: "another-login" };
    expect(errorOf(await finish(attempt.state, attempt.cookie))).toBeTruthy();
    expect(exchanged).toEqual([`c1|${c.APP_ORIGIN}/api/auth/callback|43`]);
    // The configured operator joins without an invite and the session opens the API
    claims = { ...claims, nonce: attempt.nonce };
    const session = sessionOf(await finish(attempt.state, attempt.cookie));
    expect(session).toBeTruthy();
    const me = await auth.identity(new Request(c.APP_ORIGIN, { headers: { cookie: session! } }));
    expect(me.role).toBe("admin");
    expect(me.email).toBe("owner@example.com");

    // Everyone else needs an invite issued to their own verified email
    attempt = await begin();
    claims = {
      sub: "g-guest",
      email: "guest@example.com",
      email_verified: true,
      nonce: attempt.nonce,
    };
    expect(errorOf(await finish(attempt.state, attempt.cookie))).toBe(
      "이 이메일로 발급된 초대가 필요합니다",
    );
    const invite = new URLSearchParams(
      new URL(await auth.invite("guest@example.com")).hash.slice(1),
    ).get("invite")!;
    attempt = await begin(invite);
    claims = { ...claims, email_verified: false, nonce: attempt.nonce };
    const unverified = await finish(attempt.state, attempt.cookie);
    expect(errorOf(unverified)).toBe("확인된 이메일이 필요합니다");
    // The failed callback hands the invite back so the player can retry from the same link
    expect(new URL(unverified.headers.get("location")!).hash).toContain(`invite=${invite}`);
    attempt = await begin(invite);
    claims = { ...claims, email_verified: true, nonce: attempt.nonce };
    const guest = sessionOf(await finish(attempt.state, attempt.cookie));
    expect(
      (await auth.identity(new Request(c.APP_ORIGIN, { headers: { cookie: guest! } }))).role,
    ).toBe("member");
    // The invite is spent; the same Google subject keeps signing in without it
    await expect(begin(invite)).rejects.toMatchObject({ status: 403 });
    attempt = await begin();
    claims = { ...claims, nonce: attempt.nonce };
    expect(sessionOf(await finish(attempt.state, attempt.cookie))).toBeTruthy();
    // A deleted account loses its Google link; signing in again starts a new member
    await auth.deleteAccount(me.id);
    attempt = await begin();
    claims = {
      sub: "g-owner",
      email: "owner@example.com",
      email_verified: true,
      nonce: attempt.nonce,
    };
    await expect(
      auth.identity(new Request(c.APP_ORIGIN, { headers: { cookie: session! } })),
    ).rejects.toMatchObject({ status: 401 });
    const rejoined = sessionOf(await finish(attempt.state, attempt.cookie));
    expect(
      (await auth.identity(new Request(c.APP_ORIGIN, { headers: { cookie: rejoined! } }))).id,
    ).not.toBe(me.id);
  });
  it("rejects foreign nested resources, CSRF and production developer routes before execution", async () => {
    const c = {
      ...configuration({ GAFFER_DATA_DIR: directory }),
      GAFFER_MODE: "production" as const,
      APP_ORIGIN: "https://gaffer.test",
    };
    const service = new Service(c, db, jobs.objects);
    const token = randomUUID();
    await db.query(
      "INSERT INTO private.sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hash(token), other],
    );
    const game = randomUUID();
    await db.query("INSERT INTO private.games(id,owner_id) VALUES($1,$2)", [game, owner]);
    for (const suffix of ["", "/mail", "/negotiation", "/player/p", "/match/live", "/trace/0"])
      await expect(
        service.handle(
          new Request(`https://gaffer.test/api/games/${game}${suffix}`, {
            headers: { cookie: `gaffer_session=${token}` },
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.handle(
        new Request("https://gaffer.test/api/feedback", {
          method: "POST",
          headers: { cookie: `gaffer_session=${token}`, origin: "https://evil.test" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    for (const path of ["/api/admin/usage", "/api/lab"])
      await expect(
        service.handle(
          new Request(`https://gaffer.test${path}`, {
            headers: { cookie: `gaffer_session=${token}` },
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    await db.query("DELETE FROM private.games WHERE id=$1", [game]);
  });
  it("the frontend proxy preserves cookies and never caches API failures or redirects", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: [
          ["set-cookie", "a=1; HttpOnly"],
          ["set-cookie", "b=2; Secure"],
          ["Location", "https://gaffer.test/"],
          ["Cache-Control", "public, max-age=86400"],
        ],
      }),
    );
    vi.stubGlobal("fetch", upstream);
    try {
      const response = await onRequest({
        request: new Request("https://gaffer.test/api/auth/callback?code=opaque"),
        env: { API_ORIGIN: "https://fixed.run.app", APP_ORIGIN: "https://gaffer.test" },
      });
      expect(String(upstream.mock.calls[0]?.[0])).toBe(
        "https://fixed.run.app/api/auth/callback?code=opaque",
      );
      expect(response.status).toBe(302);
      expect(response.headers.getSetCookie()).toHaveLength(2);
      expect(response.headers.get("cache-control")).toBe("no-store");
      upstream.mockRejectedValue(new Error("offline"));
      const failed = await onRequest({
        request: new Request("https://gaffer.test/api/games"),
        env: { API_ORIGIN: "https://fixed.run.app", APP_ORIGIN: "https://gaffer.test" },
      });
      expect(failed.status).toBe(502);
      expect(failed.headers.get("content-type")).toContain("application/json");
      expect(failed.headers.get("cache-control")).toBe("no-store");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rolls old usage into exact daily aggregates once and retains active receipts", async () => {
    const actor = randomUUID();
    await db.query("INSERT INTO private.members(id,email_hash) VALUES($1,$2)", [actor, actor]);
    const job = await jobs.submit(actor, "/api/games", "POST", {}, randomUUID());
    const usage = randomUUID();
    await db.query(
      "INSERT INTO private.usage(id,owner_id,job_id,provider,model,price_version,reserved_micros,actual_micros,status,created_at) VALUES($1,$2,$3,'test','model','v1',100,80,'settled',now()-interval '31 days')",
      [usage, actor, job.id],
    );
    const c = configuration({ GAFFER_DATA_DIR: directory });
    await maintenance(c, db, jobs.objects);
    await maintenance(c, db, jobs.objects);
    const [row] = await db.query<{ cost_micros: string; calls: string }>(
      "SELECT cost_micros::text,calls::text FROM private.usage_daily WHERE owner_id=$1",
      [actor],
    );
    expect(row).toMatchObject({ cost_micros: "80", calls: "1" });
    expect((await jobs.get(actor, job.id)).status).toBe("queued");
    await jobs.remove(actor, job.game_id);
  });
  it("deduplicates 100 concurrent submissions and rejects changed payloads", async () => {
    const key = randomUUID();
    const submitted = await Promise.all(
      Array.from({ length: 100 }, () =>
        jobs.submit(owner, "/api/games", "POST", { teamId: "a" }, key),
      ),
    );
    expect(new Set(submitted.map((j) => j.id)).size).toBe(1);
    const job = submitted[0]!;
    await expect(
      jobs.submit(owner, "/api/games", "POST", { teamId: "b" }, key),
    ).rejects.toMatchObject({ status: 409 });
    // The browser waits for exactly this job before it submits again
    await expect(
      jobs.submit(owner, "/api/games", "POST", { teamId: "b" }, randomUUID()),
    ).rejects.toMatchObject({ status: 409, detail: { activeJobId: job.id } });
    await expect(jobs.game(other, job.game_id)).rejects.toMatchObject({ status: 404 });
    await expect(jobs.get(other, job.id)).rejects.toMatchObject({ status: 404 });
    const claimed = await jobs.claim(job.id);
    expect(claimed).not.toBeNull();
    expect(await jobs.claim(job.id)).toBeNull();
    expect(
      await jobs.commit(
        claimed!,
        { status: 200, body: { ok: true } },
        { id: job.game_id },
        { id: job.game_id },
      ),
    ).toBe(true);
    expect(
      await jobs.commit(
        claimed!,
        { status: 200, body: { ok: true } },
        { id: job.game_id },
        { id: job.game_id },
      ),
    ).toBe(false);
    expect((await jobs.game(owner, job.game_id)).revision).toBe(1);
    expect((await jobs.submit(owner, "/api/games", "POST", { teamId: "a" }, key)).id).toBe(job.id);
  });
  it("expired leases cannot heartbeat or commit, and recovered attempts fence the old worker", async () => {
    const job = await jobs.submit(owner, "/api/games", "POST", {}, randomUUID());
    const first = (await jobs.claim(job.id))!;
    await db.query("UPDATE private.jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [
      job.id,
    ]);
    expect(await jobs.heartbeat(first)).toBe(false);
    expect(await jobs.commit(first, { status: 200, body: {} }, { id: job.game_id }, {})).toBe(
      false,
    );
    await jobs.recover();
    const second = (await jobs.claim(job.id))!;
    expect(second.attempt).toBe(first.attempt + 1);
    expect(await jobs.commit(first, { status: 200, body: {} }, { id: job.game_id }, {})).toBe(
      false,
    );
    expect(await jobs.commit(second, { status: 200, body: {} }, { id: job.game_id }, {})).toBe(
      true,
    );
    const abandoned = await jobs.submit(owner, "/api/games", "POST", {}, randomUUID());
    await db.query("UPDATE private.jobs SET deadline=now()-interval '1 second' WHERE id=$1", [
      abandoned.id,
    ]);
    await jobs.recover();
    expect((await jobs.get(owner, abandoned.id)).status).toBe("expired");
    await expect(jobs.game(owner, abandoned.game_id)).rejects.toMatchObject({ status: 404 });
  });
  it("deletion prevents an in-flight result from reviving a game", async () => {
    const job = await jobs.submit(owner, "/api/games", "POST", {}, randomUUID());
    const claimed = (await jobs.claim(job.id))!;
    await jobs.remove(owner, job.game_id);
    await expect(
      jobs.commit(claimed, { status: 200, body: {} }, { id: job.game_id }, {}),
    ).rejects.toMatchObject({ status: 404 });
    expect((await jobs.get(owner, job.id)).status).toBe("cancelled");
  });
  it("background lorebook work does not reserve the game and merges only into an idle current revision", async () => {
    const parent = await jobs.submit(owner, "/api/games", "POST", {}, randomUUID());
    const first = (await jobs.claim(parent.id))!;
    await jobs.commit(first, { status: 200, body: {} }, { id: parent.game_id }, {}, null, [
      { id: "lore-a", characterId: "coach" },
    ]);
    const [row] = await db.query<{ id: string }>(
      "SELECT id FROM private.jobs WHERE game_id=$1 AND path='/internal/lorebook'",
      [parent.game_id],
    );
    const background = (await jobs.claim(row!.id))!;
    const next = await jobs.submit(
      owner,
      `/api/games/${parent.game_id}/lineup`,
      "POST",
      {},
      randomUUID(),
      parent.game_id,
    );
    expect(
      await jobs.commit(
        background,
        { status: 200, body: {} },
        { id: parent.game_id },
        {},
        null,
        [],
        1,
      ),
    ).toBe(false);
    const active = (await jobs.claim(next.id))!;
    await jobs.commit(active, { status: 200, body: {} }, { id: parent.game_id }, {});
    expect(
      await jobs.commit(
        background,
        { status: 200, body: {} },
        { id: parent.game_id },
        {},
        null,
        [],
        1,
      ),
    ).toBe(false);
    expect(
      await jobs.commit(
        background,
        { status: 200, body: {} },
        { id: parent.game_id },
        {},
        null,
        [],
        2,
      ),
    ).toBe(true);
  });
  it("unknown usage counts toward the $5 daily cap, including its exact boundary", async () => {
    const job = await jobs.submit(owner, "/api/games", "POST", {}, randomUUID());
    const active = (await jobs.claim(job.id))!;
    const c = configuration({
      GAFFER_MODE: "local",
      GAFFER_DATA_DIR: directory,
      LLM_PRICES_JSON: JSON.stringify({
        version: "test",
        models: {
          "google/test-model": {
            inputMicrosPerToken: 1_000_000,
            outputMicrosPerToken: 1,
            rpm: 100,
            tpm: 10000,
            concurrency: 2,
          },
        },
      }),
    });
    const usage = new Usage(c, db);
    await usage.init();
    const attempt = { provider: "google", model: "test-model", inputBound: 3, outputBound: 0 };
    const id = await usage.reserve(active, attempt);
    await usage.settle(id, null);
    await expect(usage.reserve(active, attempt)).rejects.toMatchObject({ kind: "budget" });
    expect(
      Number(
        (await db.query("SELECT reserved_micros FROM private.usage WHERE id=$1", [id]))[0]
          ?.reserved_micros,
      ),
    ).toBe(3_000_000);
    const remaining = await usage.reserve(active, { ...attempt, inputBound: 2 });
    await usage.settle(remaining, null);
    await expect(usage.reserve(active, { ...attempt, inputBound: 1 })).rejects.toMatchObject({
      kind: "budget",
    });
    await jobs.fail(active);
  });
  it("reclaims a crashed HTTP permit without erasing its unknown cost", async () => {
    const actor = randomUUID();
    await db.query("INSERT INTO private.members(id,email_hash) VALUES($1,$2)", [actor, actor]);
    const c = configuration({
      GAFFER_DATA_DIR: directory,
      LLM_PRICES_JSON: JSON.stringify({
        version: "test",
        models: {
          "google/recovery": {
            inputMicrosPerToken: 1,
            outputMicrosPerToken: 1,
            rpm: 100,
            tpm: 10000,
            concurrency: 2,
          },
        },
      }),
    });
    const usage = new Usage(c, db);
    await usage.init();
    const queued = await jobs.submit(actor, "/api/games", "POST", {}, randomUUID());
    const first = (await jobs.claim(queued.id))!;
    const permit = await usage.reserve(first, {
      provider: "google",
      model: "recovery",
      inputBound: 10,
      outputBound: 5,
    });
    await db.query("UPDATE private.jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [
      queued.id,
    ]);
    await jobs.recover();
    const [old] = await db.query("SELECT status,reserved_micros FROM private.usage WHERE id=$1", [
      permit,
    ]);
    expect(old?.status).toBe("unknown");
    expect(Number(old?.reserved_micros)).toBe(15);
    const second = (await jobs.claim(queued.id))!;
    const next = await usage.reserve(second, {
      provider: "google",
      model: "recovery",
      inputBound: 10,
      outputBound: 5,
    });
    await usage.settle(next, { inputTokens: 2, outputTokens: 1 });
    expect(
      Number(
        (await db.query("SELECT token_bound FROM private.usage WHERE id=$1", [next]))[0]
          ?.token_bound,
      ),
    ).toBe(3);
    await jobs.fail(second);
  });
  it("RLS rejects unscoped reads and cross-owner writes even without owner filters", async () => {
    await db.transaction(async (sql) => {
      await sql.query("SET LOCAL ROLE gaffer_api");
      expect(await sql.query("SELECT id FROM private.games")).toEqual([]);
      await sql.query("SELECT set_config('gaffer.actor',$1,true)", [other]);
      expect(await sql.query("SELECT id FROM private.games")).toEqual([]);
      expect(
        await sql.query(
          "UPDATE private.games SET revision=revision+1 WHERE owner_id=$1 RETURNING id",
          [owner],
        ),
      ).toEqual([]);
    });
  });
  it("a failed backup releases only its own pin and the next backup can complete", async () => {
    const c = configuration({ GAFFER_DATA_DIR: join(directory, "retry-copy") });
    const target = objectStore(c);
    let fail = true;
    const copy = {
      ...target,
      put: async (key: string, body: Uint8Array) => {
        if (fail) {
          fail = false;
          throw new Error("transient");
        }
        await target.put(key, body);
      },
    };
    const backup = new Backup(db, jobs.objects, [copy], Buffer.alloc(32, 9));
    await expect(backup.create()).rejects.toThrow("transient");
    expect(await db.query("SELECT key FROM private.operations WHERE key='gc_pin'")).toEqual([]);
    expect(await backup.create()).toMatch(/^backups\//);
    const [row] = await db.query<{ value: { objects: number } }>(
      "SELECT value FROM private.operations WHERE key='last_backup'",
    );
    const [current] = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM private.games WHERE snapshot_key IS NOT NULL",
    );
    expect(row!.value.objects).toBeLessThanOrEqual(Number(current?.n) * 2);
  });
  it("restores verified encrypted copies, invalidates sessions, and reapplies newer deletions", async () => {
    const c = configuration({ GAFFER_MODE: "local", GAFFER_DATA_DIR: directory });
    const first = objectStore({ ...c, GAFFER_DATA_DIR: join(directory, "copy-one") });
    const second = objectStore({ ...c, GAFFER_DATA_DIR: join(directory, "copy-two") });
    const backup = new Backup(db, jobs.objects, [first, second], Buffer.alloc(32, 7));
    const manifest = await backup.create();
    expect(Buffer.from(await first.get(manifest)).includes(Buffer.from("email_hash"))).toBe(false);
    const [game] = await db.query<{ snapshot_key: string }>(
      "SELECT snapshot_key FROM private.games WHERE snapshot_key IS NOT NULL LIMIT 1",
    );
    await jobs.objects.delete(game!.snapshot_key);
    await jobs.objects.put(`tombstones/${other}`, encode({ ownerId: other }));
    await backup.restore(manifest, 1);
    expect((await jobs.objects.get(game!.snapshot_key)).byteLength).toBeGreaterThan(0);
    expect(await db.query("SELECT token_hash FROM private.sessions")).toEqual([]);
    expect(
      (await db.query("SELECT active FROM private.members WHERE id=$1", [other]))[0]?.active,
    ).toBe(false);
    expect(
      (await db.query("SELECT value FROM private.operations WHERE key='maintenance'"))[0]?.value,
    ).toBe(true);
    await expect(backup.create()).rejects.toThrow("pinned");
  });
  it("cryptographic state rejects tampering and production cannot use a local bypass", () => {
    expect(postgresOptions("postgres://u:p@db.example/db?sslmode=disable").ssl).toMatchObject({
      rejectUnauthorized: true,
    });
    const c = configuration({
      GAFFER_MODE: "local",
      GAFFER_AUTH_MODE: "development",
      GAFFER_DATA_DIR: directory,
    });
    const auth = new Auth(c, db);
    const sealed = auth.encrypt({ secret: "refresh" });
    expect(auth.decrypt(sealed)).toEqual({ secret: "refresh" });
    const bytes = Buffer.from(sealed, "base64url");
    bytes[30] = bytes[30]! ^ 1;
    expect(() => auth.decrypt(bytes.toString("base64url"))).toThrow();
    expect(() => configuration({ GAFFER_MODE: "local", K_SERVICE: "api" })).toThrow();
    expect(() => configuration({ GAFFER_MODE: "production" })).toThrow();
  });
});
