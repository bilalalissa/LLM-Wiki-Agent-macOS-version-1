import fs from "node:fs";
import path from "node:path";
import { getConfig, hasRealKey } from "./config.mjs";
import { listVaults, listRawCandidates, vaultName } from "./vaults.mjs";

const config = getConfig();
const vaults = listVaults(config.vaultsRoot);

console.log(`Provider: ${config.provider}`);
console.log(`Model: ${config.model}`);
console.log(`Auth method: ${providerAuthMethod(config)}`);

console.log(`Credential configured: ${credentialConfigured(config) ? "yes" : "no"}`);

console.log(`Vaults found: ${vaults.length}`);
for (const vault of vaults) {
  console.log(`- ${vaultName(vault)}`);
  console.log(`  AGENTS.md: ${fs.existsSync(path.join(vault, "AGENTS.md")) ? "yes" : "no"}`);
  console.log(`  pending raw files: ${listRawCandidates(vault).length}`);
}

function providerAuthMethod(config) {
  if (config.provider === "openai") return config.openai.authMethod;
  if (config.provider === "anthropic") return config.anthropic.authMethod;
  if (config.provider === "openai_compat") return config.openaiCompat.authMethod;
  if (config.provider === "gemini") return config.gemini.authMethod;
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) return "subscription_cli";
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(config.provider)) return "unsupported_account_auth";
  return "unknown";
}

function credentialConfigured(config) {
  if (config.provider === "openai") return hasRealKey(config.openai.apiKey);
  if (config.provider === "anthropic") return hasRealKey(config.anthropic.apiKey);
  if (config.provider === "openai_compat") {
    return config.openaiCompat.authMethod === "bearer"
      ? hasRealKey(config.openaiCompat.bearerToken)
      : hasRealKey(config.openaiCompat.apiKey);
  }
  if (config.provider === "gemini") {
    return config.gemini.authMethod === "oauth"
      ? hasRealKey(config.gemini.oauthAccessToken) || Boolean(config.gemini.oauthTokenFile)
      : hasRealKey(config.gemini.apiKey);
  }
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) return config.openai.subscriptionClient === "codex" && Boolean(config.openai.codexCommand);
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(config.provider)) return false;
  return false;
}
