import "dotenv/config";
import { loadConfig } from "./config.js";
import { createDatabase, migrateDatabase } from "./db.js";

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command !== "migrate") {
    process.stderr.write("Usage: sorex-query-api migrate\n");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const handle = createDatabase({ driver: config.storageDriver, url: config.DATABASE_URL });
  try {
    await migrateDatabase(handle);
    process.stdout.write(`Query API schema ready (${config.storageDriver})\n`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
