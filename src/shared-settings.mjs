import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listVaults, vaultName } from "./vaults.mjs";

export function defaultSharedSettings(config) {
  return {
    schemaVersion: 1,
    provider: {
      mode: config.provider || "openai_subscription",
      transport: ["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider) ? "mac_bridge" : "direct_api",
      defaultModel: config.model || "gpt-5.4",
      credentialStatus: "local_only",
      bridgeURL: ""
    },
    ingest: {
      autoScanOnForeground: true,
      scanIntervalSeconds: Math.max(60, Math.round((config.watchIntervalMs || 5000) / 1000)),
      maxCharacters: config.ingestMaxChars || 60000
    },
    search: {
      maxFiles: config.chatMaxFiles || 24,
      localResultView: "combined",
      localResultExpand: "first"
    },
    display: {
      theme: "light",
      noteDisplayMode: "box",
      snapSize: 34,
      textDirection: "auto"
    },
    wiki: {
      enabledSections: [
        "Open Questions",
        "Contradictions",
        "Source's Related Learning Questions",
        "Open Learning Questions"
      ]
    },
    lastKnownAgents: []
  };
}

export function sharedSettingsPath(vaultPath) {
  return path.join(vaultPath, ".llm-wiki", "settings.json");
}

export function ensureSharedSettings(vaultPath, config) {
  const file = sharedSettingsPath(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let settings = defaultSharedSettings(config);
  if (fs.existsSync(file)) {
    try {
      settings = migrateSharedSettings(JSON.parse(fs.readFileSync(file, "utf8")), config);
    } catch {
      settings = defaultSharedSettings(config);
    }
  }
  settings = markAgentSeen(redactSharedSettings(settings));
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

export function readSharedSettings(vaultPath, config) {
  return ensureSharedSettings(vaultPath, config);
}

export function writeSharedSettings(vaultPath, config, input) {
  const current = ensureSharedSettings(vaultPath, config);
  const next = redactSharedSettings(migrateSharedSettings({ ...current, ...input }, config));
  fs.mkdirSync(path.dirname(sharedSettingsPath(vaultPath)), { recursive: true });
  fs.writeFileSync(sharedSettingsPath(vaultPath), `${JSON.stringify(markAgentSeen(next), null, 2)}\n`);
  return next;
}

export function sharedSettingsSummary(config) {
  return listVaults(config.vaultsRoot).map((vaultPath) => ({
    vault: vaultName(vaultPath),
    settings: ensureSharedSettings(vaultPath, config)
  }));
}

export function sharedSettingsForVault(config, name) {
  const vaultPath = resolveVault(config, name);
  return {
    vault: vaultName(vaultPath),
    settings: ensureSharedSettings(vaultPath, config)
  };
}

export function updateSharedSettingsForVault(config, name, input) {
  const vaultPath = resolveVault(config, name);
  return {
    vault: vaultName(vaultPath),
    settings: writeSharedSettings(vaultPath, config, normalizeInput(input))
  };
}

export function listBridgeVaults(config) {
  return listVaults(config.vaultsRoot).map((vaultPath) => ({
    name: vaultName(vaultPath),
    sharedSettings: ensureSharedSettings(vaultPath, config)
  }));
}

function migrateSharedSettings(value, config) {
  const defaults = defaultSharedSettings(config);
  const provider = { ...defaults.provider, ...(value.provider || {}) };
  const ingest = { ...defaults.ingest, ...(value.ingest || {}) };
  const search = { ...defaults.search, ...(value.search || {}) };
  const display = { ...defaults.display, ...(value.display || {}) };
  const wiki = { ...defaults.wiki, ...(value.wiki || {}) };
  return {
    schemaVersion: Math.max(Number(value.schemaVersion || 1), defaults.schemaVersion),
    provider,
    ingest,
    search,
    display,
    wiki,
    lastKnownAgents: Array.isArray(value.lastKnownAgents) ? value.lastKnownAgents : []
  };
}

function redactSharedSettings(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  next.provider.credentialStatus = "local_only";
  for (const key of Object.keys(next.provider)) {
    if (/key|token|secret|password/i.test(key)) delete next.provider[key];
  }
  return next;
}

function markAgentSeen(settings) {
  const agent = {
    platform: "macOS",
    version: "0.1.0",
    lastSeen: new Date().toISOString(),
    hostname: os.hostname()
  };
  const existing = settings.lastKnownAgents.filter((item) => item.platform !== agent.platform || item.hostname !== agent.hostname);
  settings.lastKnownAgents = [agent, ...existing].slice(0, 12);
  return settings;
}

function normalizeInput(input) {
  const allowed = {};
  for (const key of ["provider", "ingest", "search", "display", "wiki"]) {
    if (input && typeof input[key] === "object" && input[key]) allowed[key] = input[key];
  }
  return allowed;
}

function resolveVault(config, name) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === name);
  if (!vaultPath) throw new Error(`Unknown vault: ${name}`);
  return vaultPath;
}
