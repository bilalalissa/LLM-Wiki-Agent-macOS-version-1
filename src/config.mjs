import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = process.cwd();

export function configPointerFile() {
  return path.join(os.homedir(), "Library", "Application Support", "LLM Wiki Agent", "config-path.txt");
}

export function getConfigFilePath() {
  if (process.env.LLM_WIKI_ENV_FILE) return process.env.LLM_WIKI_ENV_FILE;
  const pointer = configPointerFile();
  if (fs.existsSync(pointer)) {
    const selected = fs.readFileSync(pointer, "utf8").trim();
    if (selected) return expandTilde(selected);
  }
  return path.join(ROOT, ".env");
}

export function setConfigFilePath(file) {
  const resolved = path.resolve(expandTilde(file));
  fs.mkdirSync(path.dirname(configPointerFile()), { recursive: true });
  fs.writeFileSync(configPointerFile(), `${resolved}\n`);
  process.env.LLM_WIKI_ENV_FILE = resolved;
  return resolved;
}

export function loadEnv(file = getConfigFilePath()) {
  const env = { ...process.env };
  env.LLM_WIKI_ENV_FILE = file;
  if (!fs.existsSync(file)) return env;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function getConfig() {
  const env = loadEnv();
  return {
    provider: env.DEFAULT_AI_PROVIDER || "openai",
    configFile: env.LLM_WIKI_ENV_FILE || getConfigFilePath(),
    model: env.DEFAULT_AI_MODEL || "gpt-4.1-mini",
    accessMethod: env.AI_ACCESS_METHOD || "api_key",
    vaultsRoot: path.resolve(ROOT, expandTilde(env.VAULTS_ROOT || ".")),
    watchIntervalMs: Number(env.WATCH_INTERVAL_MS || 5000),
    ingestMaxChars: Number(env.INGEST_MAX_CHARS || 60000),
    chatMaxFiles: Number(env.CHAT_MAX_FILES || 24),
    chatPort: Number(env.CHAT_PORT || 8789),
    bridgeHost: env.MAC_BRIDGE_HOST || env.CHAT_HOST || "127.0.0.1",
    bridgeToken: env.MAC_BRIDGE_TOKEN || "",
    openai: {
      authMethod: env.OPENAI_AUTH_METHOD || "api_key",
      apiKey: env.OPENAI_API_KEY || "",
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      organization: env.OPENAI_ORGANIZATION || "",
      project: env.OPENAI_PROJECT || "",
      subscriptionClient: env.OPENAI_SUBSCRIPTION_CLIENT || "codex",
      codexCommand: env.OPENAI_CODEX_COMMAND || "codex",
      codexTimeoutMs: Number(env.OPENAI_CODEX_TIMEOUT_MS || 180000)
    },
    anthropic: {
      authMethod: env.ANTHROPIC_AUTH_METHOD || "api_key",
      apiKey: env.ANTHROPIC_API_KEY || "",
      baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
    },
    openaiCompat: {
      authMethod: env.OPENAI_COMPAT_AUTH_METHOD || "api_key",
      apiKey: env.OPENAI_COMPAT_API_KEY || "",
      bearerToken: env.OPENAI_COMPAT_BEARER_TOKEN || "",
      baseUrl: env.OPENAI_COMPAT_BASE_URL || "http://localhost:1234/v1"
    },
    gemini: {
      authMethod: env.GEMINI_AUTH_METHOD || "api_key",
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
      oauthAccessToken: env.GEMINI_OAUTH_ACCESS_TOKEN || "",
      oauthTokenFile: env.GEMINI_OAUTH_TOKEN_FILE || "",
      baseUrl: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com"
    }
  };
}

function expandTilde(value) {
  const text = String(value || "");
  if (text === "~") return process.env.HOME || text;
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return text;
}

export function hasRealKey(value) {
  return Boolean(value && !value.startsWith("replace-with-"));
}
