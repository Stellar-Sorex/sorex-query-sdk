import pino, { type Logger } from "pino";

export type { Logger };

/** Structured JSON logger; pretty output is opt-in for local development. */
export function createLogger(level: string, pretty = false): Logger {
  const options = {
    level,
    base: { service: "sorex-query-sdk" },
    redact: {
      paths: ["databaseUrl", "redisUrl", "*.databaseUrl", "*.redisUrl", "req.headers.authorization"],
      censor: "[redacted]",
    },
  };
  if (pretty) {
    return pino({
      ...options,
      transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
    });
  }
  return pino(options);
}
