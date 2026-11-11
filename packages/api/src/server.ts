import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bundle = await buildApp(config);
  await bundle.app.listen({ port: config.PORT, host: config.HOST });
  bundle.logger.info(
    { port: config.PORT, host: config.HOST, graphql: "/graphql", rest: "/v1", docs: "/docs" },
    "sorex query API listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bundle.logger.info({ signal }, "shutting down");
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    await bundle.app.close();
    clearTimeout(timer);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
