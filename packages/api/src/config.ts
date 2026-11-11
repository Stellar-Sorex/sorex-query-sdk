import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1).default("sqlite:./data/sorex-read.db"),
  STORAGE_DRIVER: z.enum(["postgres", "sqlite"]).optional(),
  REDIS_URL: optionalString,
  CORS_ORIGIN: z.string().default("*"),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),
  CACHE_MAX_ITEMS: z.coerce.number().int().min(1).default(500),
  MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  QUERY_DEPTH_LIMIT: z.coerce.number().int().min(1).max(30).default(8),
  QUERY_COMPLEXITY_LIMIT: z.coerce.number().int().min(1).default(300),
  SUBSCRIPTION_POLL_MS: z.coerce.number().int().min(250).default(1_000),
  METRICS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  NETWORK: z.enum(["testnet", "mainnet", "futurenet", "custom"]).default("testnet"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  LOG_PRETTY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

export interface ApiConfig extends Omit<Env, "STORAGE_DRIVER"> {
  storageDriver: "postgres" | "sqlite";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Validate API configuration, failing fast on bad values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment: ${details}`);
  }
  const value = parsed.data;
  const storageDriver =
    value.STORAGE_DRIVER ??
    (/^postgres(ql)?:\/\//.test(value.DATABASE_URL) ? "postgres" : "sqlite");
  if (storageDriver === "postgres" && !/^postgres(ql)?:\/\//.test(value.DATABASE_URL)) {
    throw new ConfigError("STORAGE_DRIVER=postgres requires a postgres:// DATABASE_URL");
  }
  return { ...value, storageDriver };
}
