import { getConfig } from "./config.mjs";
import { createProvider } from "./provider.mjs";
import { ingestVault } from "./ingest-lib.mjs";
import { listVaults } from "./vaults.mjs";
import { bootstrapVault } from "./vault-bootstrap.mjs";

const config = getConfig();
const provider = createProvider(config);
const vaults = listVaults(config.vaultsRoot);

if (!vaults.length) {
  console.log("No Obsidian or *-vault folders found.");
  process.exit(0);
}

let total = 0;
for (const vault of vaults) {
  bootstrapVault(vault);
  const results = await ingestVault(vault, config, provider);
  total += results.length;
  for (const result of results) {
    console.log(`[${result.vault}] ${result.source} -> ${result.sourcePage}`);
  }
}

if (!total) console.log("No raw files found for ingestion.");
