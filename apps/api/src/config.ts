import { resolve } from "node:path";
import { z } from "zod";

const Env = z.object({
  GAFFER_MODE: z.enum(["local", "production"]).default("local"),
  GAFFER_AUTH_MODE: z.enum(["google", "development"]).default("google"),
  SERVICE_ROLE: z.enum(["api", "worker", "sim", "maintenance"]).default("api"),
  PORT: z.coerce.number().int().min(1).default(3320),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  GAFFER_DATA_DIR: z.string().default("/tmp/gaffer-service"),
  DATABASE_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** 초대 없이 운영자로 가입하는 확인된 Google 이메일 — 쉼표로 여럿 */
  ADMIN_EMAILS: z.string().optional(),
  SESSION_KEY: z.string().optional(),
  EMAIL_HASH_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  GCP_PROJECT: z.string().optional(),
  GCP_REGION: z.string().default("asia-northeast1"),
  SIM_TASK_QUEUE: z.string().default("gaffer-sim"),
  BACKGROUND_TASK_QUEUE: z.string().default("gaffer-background"),
  TASK_QUEUE: z.string().default("gaffer-jobs"),
  TASK_SERVICE_ACCOUNT: z.string().optional(),
  API_SERVICE_ACCOUNT: z.string().optional(),
  WORKER_URL: z.string().url().optional(),
  SIM_URL: z.string().url().optional(),
  USER_DAILY_BUDGET_MICROS: z.coerce.number().int().positive().default(5_000_000),
  GLOBAL_DAILY_BUDGET_MICROS: z.coerce.number().int().positive().default(10_000_000),
  LLM_PRICES_JSON: z.string().optional(),
  LLM_PRICES_FILE: z.string().optional(),
  MAINTENANCE_URL: z.string().url().optional(),
});
export type Config = z.infer<typeof Env>;
export function configuration(env: NodeJS.ProcessEnv = process.env): Config {
  const c = Env.parse(env);
  if (c.GAFFER_MODE === "production") {
    if (c.GAFFER_AUTH_MODE !== "google")
      throw new Error("Google authentication is required in production");
    if (!env.USER_DAILY_BUDGET_MICROS || !env.GLOBAL_DAILY_BUDGET_MICROS)
      throw new Error("Explicit production budgets required");
    const required: (keyof Config)[] = [
      "DATABASE_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "SESSION_KEY",
      "EMAIL_HASH_KEY",
      "R2_ENDPOINT",
      "R2_BUCKET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "GCP_PROJECT",
      "TASK_SERVICE_ACCOUNT",
      "WORKER_URL",
      "SIM_URL",
    ];
    if (!c.LLM_PRICES_FILE && !c.LLM_PRICES_JSON) throw new Error("LLM prices are required");
    for (const key of required) if (!c[key]) throw new Error(`Missing ${key}`);
    if (!c.APP_ORIGIN.startsWith("https://")) throw new Error("APP_ORIGIN must use HTTPS");
    if (Buffer.from(c.SESSION_KEY!, "base64").length !== 32)
      throw new Error("SESSION_KEY must be 32 base64 bytes");
    if (env.LLM_MODE === "mock") throw new Error("Mock LLM is forbidden in production");
  } else if (env.NODE_ENV === "production" || env.K_SERVICE)
    throw new Error("Local mode is forbidden on production hosts");
  if (resolve(c.GAFFER_DATA_DIR).includes("/apps/web/.data"))
    throw new Error("Use an isolated service data directory");
  return c;
}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
