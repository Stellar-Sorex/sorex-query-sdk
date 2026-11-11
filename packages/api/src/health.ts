import type { ApiConfig } from "./config.js";
import type { Repository } from "./repository.js";
import type { HealthRecord } from "./types.js";

export const VERSION = "0.1.0";

/** Build the shared REST/GraphQL health payload from indexed data. */
export async function buildHealth(
  repository: Repository,
  config: ApiConfig,
): Promise<HealthRecord> {
  const [latestLedger, indexedEvents, indexedContracts, lastIndexedAt] = await Promise.all([
    repository.latestEventLedger(),
    repository.countEvents(),
    repository.countContracts(),
    repository.latestIndexedAt(),
  ]);

  return {
    status: "ok",
    network: config.NETWORK,
    latestLedger,
    indexedEvents,
    indexedContracts,
    lastIndexedAt,
    database: config.storageDriver,
    version: VERSION,
  };
}
