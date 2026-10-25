import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { Config } from "./config";
import { HttpError } from "./config";
import type { Database } from "./database";
import { hash } from "./objects";

export const LOCAL_OWNER = "00000000-0000-4000-8000-000000000001";
export interface Identity {
  id: string;
  role: string;
}

/** ID token에서 로그인이 읽는 칸 — 서명·발급자·`aud`·만료는 `verify`가 이미 확인했다 */
export interface GoogleClaims {
  sub: string;
  email?: string | undefined;
  email_verified?: boolean | undefined;
  nonce?: string | undefined;
}

/** Google과 실제로 오가는 두 걸음. 테스트가 네트워크 없이 대신 선다 */
export interface GoogleOidc {
  /** 인가 코드 → ID token (client secret과 PKCE verifier로 교환) */
  exchange(code: string, verifier: string, redirectUri: string): Promise<string>;
  verify(idToken: string): Promise<GoogleClaims>;
}

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const PENDING_SECONDS = 600;
const SESSION_SECONDS = 7 * 24 * 3600;
const GOOGLE_TIMEOUT_MS = 10_000;

const Pending = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(43),
  invite: z.string(),
  expires: z.number(),
});
type Pending = z.infer<typeof Pending>;

const randomToken = () => randomBytes(32).toString("base64url");
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("google timeout")), GOOGLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export class Auth {
  constructor(
    readonly c: Config,
    readonly db: Database,
    private readonly google: GoogleOidc | null = null,
  ) {}
  get development(): boolean {
    return this.c.GAFFER_MODE === "local" && this.c.GAFFER_AUTH_MODE === "development";
  }
  get redirectUri(): string {
    return `${this.c.APP_ORIGIN}/api/auth/callback`;
  }
  emailHash(email: string): string {
    return createHmac("sha256", this.c.EMAIL_HASH_KEY ?? "local-only")
      .update(email.trim().toLowerCase())
      .digest("hex");
  }
  private adminEmail(email: string): boolean {
    return (this.c.ADMIN_EMAILS ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .includes(email.trim().toLowerCase());
  }
  private key(): Buffer {
    if (!this.c.SESSION_KEY && !this.development)
      throw new HttpError(503, "로그인을 준비 중입니다");
    return this.c.SESSION_KEY ? Buffer.from(this.c.SESSION_KEY, "base64") : Buffer.alloc(32);
  }
  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  }
  decrypt(value: string): unknown {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
    ) as unknown;
  }
  cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.c.GAFFER_MODE === "production" ? "; Secure" : ""}`;
  }
  cookies(req: Request): Record<string, string> {
    return Object.fromEntries(
      (req.headers.get("cookie") ?? "")
        .split(";")
        .map((x) => x.trim().split("="))
        .filter((x): x is [string, string] => x.length === 2),
    );
  }
  async identity(req: Request): Promise<Identity> {
    if (this.development) {
      const candidate = this.cookies(req)["gaffer_local"];
      const id = candidate && /^[0-9a-f-]{36}$/.test(candidate) ? candidate : LOCAL_OWNER;
      await this.db.query(
        "INSERT INTO private.members(id,email_hash,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING",
        [id, id],
      );
      return { id, role: "admin" };
    }
    const token = this.cookies(req)["gaffer_session"];
    if (!token) throw new HttpError(401, "로그인이 필요합니다");
    const [session] = await this.db.query<{ id: string; role: string }>(
      "SELECT m.id,m.role FROM private.sessions s JOIN private.members m ON m.id=s.owner_id WHERE s.token_hash=$1 AND s.expires_at>now() AND m.active",
      [hash(token)],
    );
    if (!session) throw new HttpError(401, "세션이 만료되었습니다");
    return session;
  }
  async invite(email: string): Promise<string> {
    const token = randomToken();
    await this.db.query(
      "INSERT INTO private.invites(token_hash,email_hash,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [hash(token), this.emailHash(email)],
    );
    await this.db.query(
      "INSERT INTO private.audit(id,action,subject) VALUES($1,'invite_created',$2)",
      [randomUUID(), this.emailHash(email)],
    );
    return `${this.c.APP_ORIGIN}/#invite=${token}`;
  }
  /** 로그인에 필요한 설정이 모두 있을 때만 Google과 대화한다 */
  private oidc(): GoogleOidc {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_KEY, EMAIL_HASH_KEY } = this.c;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_KEY || !EMAIL_HASH_KEY)
      throw new HttpError(503, "로그인을 준비 중입니다");
    if (this.google) return this.google;
    const client = new OAuth2Client({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: this.redirectUri,
    });
    return {
      exchange: async (code, verifier, redirectUri) => {
        const { tokens } = await within(
          client.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri }),
        );
        if (!tokens.id_token) throw new Error("Google returned no ID token");
        return tokens.id_token;
      },
      verify: async (idToken) => {
        const payload = (
          await within(client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID }))
        ).getPayload();
        if (!payload) throw new Error("Empty ID token");
        return payload;
      },
    };
  }
  async start(req: Request): Promise<Response> {
    if (this.development) return Response.json({ url: this.c.APP_ORIGIN });
    this.oidc();
    const body = z
      .object({ invite: z.string().max(200).optional() })
      .safeParse(await req.json().catch(() => ({})));
    const invite = body.success ? (body.data.invite ?? "") : "";
    if (
      invite &&
      !(
        await this.db.query(
          "SELECT token_hash FROM private.invites WHERE token_hash=$1 AND expires_at>now() AND accepted_by IS NULL",
          [hash(invite)],
        )
      ).length
    )
      throw new HttpError(403, "유효한 초대가 아닙니다");
    const pending: Pending = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
      invite,
      expires: Date.now() + PENDING_SECONDS * 1000,
    };
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: this.c.GOOGLE_CLIENT_ID!,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid email",
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return Response.json(
      { url: url.toString() },
      {
        headers: {
          "Set-Cookie": this.cookie("gaffer_oauth", this.encrypt(pending), PENDING_SECONDS),
        },
      },
    );
  }
  /**
   * Google이 돌려보낸 자리. 실패도 화면으로 돌아가야 하므로 JSON이 아니라
   * `/#login_error=`로 보낸다. 초대 링크로 들어왔으면 그 초대를 다시 싣는다.
   */
  async callback(req: Request): Promise<Response> {
    let pending: Pending | null = null;
    try {
      const raw = this.cookies(req)["gaffer_oauth"];
      if (raw) pending = this.pending(raw);
      const token = await this.signIn(req, pending);
      const headers = new Headers({ Location: `${this.c.APP_ORIGIN}/` });
      headers.append("Set-Cookie", this.cookie("gaffer_session", token, SESSION_SECONDS));
      headers.append("Set-Cookie", this.cookie("gaffer_oauth", "", 0));
      return new Response(null, { status: 302, headers });
    } catch (error) {
      const known = error instanceof HttpError;
      console.warn(JSON.stringify({ event: "login_failed", status: known ? error.status : 500 }));
      const back = new URLSearchParams();
      if (pending?.invite) back.set("invite", pending.invite);
      back.set("login_error", known ? error.message : "로그인에 실패했습니다");
      const headers = new Headers({ Location: `${this.c.APP_ORIGIN}/#${back.toString()}` });
      headers.append("Set-Cookie", this.cookie("gaffer_oauth", "", 0));
      return new Response(null, { status: 302, headers });
    }
  }
  private pending(raw: string): Pending | null {
    try {
      const value = Pending.parse(this.decrypt(raw));
      return value.expires > Date.now() ? value : null;
    } catch {
      return null;
    }
  }
  private async signIn(req: Request, pending: Pending | null): Promise<string> {
    const params = new URL(req.url).searchParams;
    if (params.get("error")) throw new HttpError(401, "로그인을 취소했습니다");
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state || !pending || !same(state, pending.state))
      throw new HttpError(400, "로그인 요청이 만료되었습니다. 다시 시도해 주세요");
    const google = this.oidc();
    let claims: GoogleClaims;
    try {
      claims = await google.verify(await google.exchange(code, pending.verifier, this.redirectUri));
    } catch {
      throw new HttpError(401, "Google 로그인을 확인하지 못했습니다");
    }
    if (!same(claims.nonce ?? "", pending.nonce))
      throw new HttpError(401, "Google 로그인을 확인하지 못했습니다");
    if (!claims.email || claims.email_verified !== true)
      throw new HttpError(403, "확인된 이메일이 필요합니다");
    const email = claims.email;
    const emailHash = this.emailHash(email);
    const invited = pending.invite;
    const token = randomToken();
    await this.db.transaction(async (sql) => {
      const [member] = await sql.query<{ id: string; active: boolean }>(
        "SELECT id,active FROM private.members WHERE google_sub=$1 FOR UPDATE",
        [claims.sub],
      );
      if (member && !member.active) throw new HttpError(403, "참여가 종료된 계정입니다");
      let id = member?.id;
      if (!id) {
        id = randomUUID();
        if (
          (await sql.query("SELECT id FROM private.members WHERE email_hash=$1", [emailHash]))
            .length
        )
          throw new HttpError(403, "이 이메일은 다른 Google 계정에 연결되어 있습니다");
        if (this.adminEmail(email)) {
          await sql.query(
            "INSERT INTO private.members(id,google_sub,email_hash,role) VALUES($1,$2,$3,'admin')",
            [id, claims.sub, emailHash],
          );
        } else {
          const [invite] = await sql.query(
            "SELECT token_hash FROM private.invites WHERE token_hash=$1 AND email_hash=$2 AND accepted_by IS NULL AND expires_at>now() FOR UPDATE",
            [hash(invited), emailHash],
          );
          if (!invite) throw new HttpError(403, "이 이메일로 발급된 초대가 필요합니다");
          await sql.query(
            "INSERT INTO private.members(id,google_sub,email_hash) VALUES($1,$2,$3)",
            [id, claims.sub, emailHash],
          );
          await sql.query("UPDATE private.invites SET accepted_by=$1 WHERE token_hash=$2", [
            id,
            hash(invited),
          ]);
        }
        await sql.query(
          "INSERT INTO private.analytics(id,owner_id,name) VALUES($1,$2,'invite_accepted')",
          [randomUUID(), id],
        );
      }
      await sql.query(
        `INSERT INTO private.sessions(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '${SESSION_SECONDS} seconds')`,
        [hash(token), id],
      );
    });
    return token;
  }
  async logout(req: Request): Promise<Response> {
    await this.db.query("DELETE FROM private.sessions WHERE token_hash=$1", [
      hash(this.cookies(req)["gaffer_session"] ?? ""),
    ]);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": this.cookie("gaffer_session", "", 0) } },
    );
  }
  async deleteAccount(owner: string): Promise<void> {
    await this.db.transaction(async (sql) => {
      // 로그인 식별자를 지운다 — 같은 Google 계정은 다시 초대받아야 들어온다
      await sql.query(
        "UPDATE private.members SET active=false,google_sub=NULL,email_hash='deleted:'||id::text WHERE id=$1",
        [owner],
      );
      await sql.query(
        "INSERT INTO private.tombstones(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
        [owner],
      );
      await sql.query("DELETE FROM private.sessions WHERE owner_id=$1", [owner]);
      await sql.query(
        "UPDATE private.jobs SET status='cancelled',lease_until=NULL,payload='{}' WHERE owner_id=$1 AND status IN ('queued','running')",
        [owner],
      );
      await sql.query(
        "UPDATE private.games SET deleted_at=now(),active_job=NULL WHERE owner_id=$1",
        [owner],
      );
      await sql.query("DELETE FROM private.feedback WHERE owner_id=$1", [owner]);
      await sql.query("DELETE FROM private.analytics WHERE owner_id=$1", [owner]);
      await sql.query("DELETE FROM private.diagnostics WHERE owner_id=$1", [owner]);
      await sql.query("UPDATE private.jobs SET payload='{}' WHERE owner_id=$1", [owner]);
    });
  }
}
