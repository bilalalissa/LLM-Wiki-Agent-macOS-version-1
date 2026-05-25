import { getConfig } from "./config.mjs";
import { createProvider } from "./provider.mjs";
import { ingestVault } from "./ingest-lib.mjs";
import { listVaults } from "./vaults.mjs";
import { bootstrapVault } from "./vault-bootstrap.mjs";

const config = getConfig();
const provider = createProvider(config);

console.log(`Watching vault raw folders every ${config.watchIntervalMs}ms.`);

async function tick() {
  for (const vault of listVaults(config.vaultsRoot)) {
    try {
      bootstrapVault(vault, config);
      const results = await ingestVault(vault, config, provider);
      for (const result of results) {
        console.log(`[${result.vault}] ingested ${result.source}`);
      }
    } catch (error) {
      console.error(`[watch] ${error.message}`);
    }
  }
}

await tick();
setInterval(tick, config.watchIntervalMs);
