import fs from "node:fs";
import { spawn } from "node:child_process";
import { hasRealKey } from "./config.mjs";

export async function providerStatus(config) {
  const live = await liveStatus(config);
  return {
    provider: config.provider,
    model: config.model,
    configFile: config.configFile,
    accessMethod: config.accessMethod,
    authMethod: providerAuthMethod(config),
    credentialConfigured: credentialConfigured(config),
    status: live.label,
    statusColor: live.color,
    statusDetail: live.detail,
    details: providerDetails(config),
    safety: [
      "Secret values are never returned by this endpoint.",
      "Only configured/not configured flags are shown for API keys and tokens."
    ]
  };
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
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) {
    return config.openai.subscriptionClient === "codex" && Boolean(config.openai.codexCommand);
  }
  return false;
}

async function liveStatus(config) {
  if (!credentialConfigured(config)) {
    return status("Needs configuration", "red", "Required provider credentials or client settings are missing.");
  }
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(config.provider)) {
    return status("Unsupported", "red", "This auth mode is not supported by the current provider adapter.");
  }
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(config.provider)) {
    return codexLoginStatus(config);
  }
  return status("Configured", "orange", "Credentials are configured. Live connection is not checked to avoid making provider calls from this status page.");
}

async function codexLoginStatus(config) {
  try {
    const result = await runCommand(config.openai.codexCommand || "codex", ["login", "status"], 8000);
    if (result.code === 0 && /logged in/i.test(result.output)) {
      return status("Connected", "green", result.output);
    }
    return status("Login not active", "red", result.output || "Codex login status did not report an active login.");
  } catch (error) {
    return status("Unknown", "grey", error.message);
  }
}

function status(label, color, detail) {
  return { label, color, detail };
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [bin, ...prefixArgs] = String(command || "codex").trim().split(/\s+/).filter(Boolean);
    const child = spawn(bin || "codex", [...prefixArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Status check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: cleanOutput(output) });
    });
  });
}

function cleanOutput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("WARNING: proceeding, even though we could not update PATH"))
    .join("\n")
    .trim();
}

function providerDetails(config) {
  if (config.provider === "openai") {
    return [
      field("Base URL", config.openai.baseUrl),
      field("API key", configured(hasRealKey(config.openai.apiKey))),
      field("Organization header", configured(Boolean(config.openai.organization))),
      field("Project header", configured(Boolean(config.openai.project)))
    ];
  }
  if (config.provider === "openai_subscription" || config.provider === "openai_oauth" || config.provider === "chatgpt") {
    return [
      field("Subscription client", config.openai.subscriptionClient),
      field("Codex command", config.openai.codexCommand),
      field("Codex timeout", `${config.openai.codexTimeoutMs}ms`),
      field("Codex command configured", configured(Boolean(config.openai.codexCommand)))
    ];
  }
  if (config.provider === "anthropic") {
    return [
      field("Base URL", config.anthropic.baseUrl),
      field("API key", configured(hasRealKey(config.anthropic.apiKey)))
    ];
  }
  if (config.provider === "openai_compat") {
    return [
      field("Base URL", config.openaiCompat.baseUrl),
      field("API key", configured(hasRealKey(config.openaiCompat.apiKey))),
      field("Bearer token", configured(hasRealKey(config.openaiCompat.bearerToken)))
    ];
  }
  if (config.provider === "gemini") {
    return [
      field("Base URL", config.gemini.baseUrl),
      field("API key", configured(hasRealKey(config.gemini.apiKey))),
      field("OAuth token", configured(hasRealKey(config.gemini.oauthAccessToken))),
      field("OAuth token file", config.gemini.oauthTokenFile ? configured(fs.existsSync(config.gemini.oauthTokenFile)) : "not configured")
    ];
  }
  return [field("Provider", "Unknown provider")];
}

function field(label, value) {
  return { label, value };
}

function configured(value) {
  return value ? "configured" : "not configured";
}
