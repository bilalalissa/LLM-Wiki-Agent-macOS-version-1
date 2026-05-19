import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hasRealKey } from "./config.mjs";
import { listVaults } from "./vaults.mjs";

export function preflightStatus(config) {
  const checks = [
    obsidianCheck(),
    clipperCheck(),
    vaultsCheck(config),
    providerCheck(config)
  ];
  return {
    ok: checks.every((check) => check.ok || check.level === "warning"),
    checks
  };
}

function obsidianCheck() {
  const paths = ["/Applications/Obsidian.app", path.join(os.homedir(), "Applications", "Obsidian.app")];
  const ok = paths.some((item) => fs.existsSync(item));
  return {
    name: "Obsidian",
    ok,
    level: ok ? "ok" : "error",
    detail: ok ? "Obsidian app found." : "Install Obsidian from https://obsidian.md."
  };
}

function clipperCheck() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library/Application Support/Google/Chrome/Default/Extensions/cnjifjpddelmedmihgijeibhnjfabmlf"),
    path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default/Extensions/cnjifjpddelmedmihgijeibhnjfabmlf"),
    path.join(home, "Library/Application Support/Microsoft Edge/Default/Extensions/eigdjhmgnaaeaonimdklocfekkaanfme"),
    "/Applications/Obsidian Web Clipper.app",
    path.join(home, "Applications/Obsidian Web Clipper.app")
  ];
  const ok = candidates.some((item) => fs.existsSync(item));
  return {
    name: "Obsidian Web Clipper",
    ok,
    level: ok ? "ok" : "warning",
    detail: ok ? "Web Clipper appears to be installed." : "Install Obsidian Web Clipper from https://obsidian.md/clipper."
  };
}

function vaultsCheck(config) {
  const count = listVaults(config.vaultsRoot).length;
  return {
    name: "Vaults",
    ok: count > 0,
    level: count > 0 ? "ok" : "error",
    detail: count > 0 ? `${count} vault(s) found. Missing LLM Wiki files are created automatically at startup.` : "Set VAULTS_ROOT to a folder containing at least one Obsidian vault. Keeping one dedicated LLM Wiki vault is a good starting practice."
  };
}

function providerCheck(config) {
  let ok = false;
  let detail = "";
  if (config.provider === "openai_subscription") {
    detail = runCodexStatus();
    ok = /logged in/i.test(detail);
  } else if (config.provider === "openai") {
    ok = hasRealKey(config.openai.apiKey);
    detail = ok ? "OpenAI API key configured." : "Set OPENAI_API_KEY.";
  } else if (config.provider === "anthropic") {
    ok = hasRealKey(config.anthropic.apiKey);
    detail = ok ? "Anthropic API key configured." : "Set ANTHROPIC_API_KEY.";
  } else if (config.provider === "gemini") {
    ok = hasRealKey(config.gemini.apiKey) || hasRealKey(config.gemini.oauthAccessToken) || Boolean(config.gemini.oauthTokenFile);
    detail = ok ? "Gemini credential configured." : "Set GEMINI_API_KEY or Gemini OAuth settings.";
  } else if (config.provider === "openai_compat") {
    ok = hasRealKey(config.openaiCompat.apiKey) || hasRealKey(config.openaiCompat.bearerToken);
    detail = ok ? "OpenAI-compatible credential configured." : "Set OPENAI_COMPAT_API_KEY or OPENAI_COMPAT_BEARER_TOKEN.";
  }
  return {
    name: "AI Provider",
    ok,
    level: ok ? "ok" : "error",
    detail: detail || `Unsupported provider: ${config.provider}`
  };
}

function runCodexStatus() {
  try {
    return execFileSync("codex", ["login", "status"], { encoding: "utf8", timeout: 8000 }).trim();
  } catch {
    return "Codex CLI is not logged in. Run `codex login`.";
  }
}
