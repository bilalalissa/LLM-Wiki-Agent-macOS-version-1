import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig, hasRealKey } from "./config.mjs";

export class ProviderError extends Error {}

export function createProvider(config = getConfig()) {
  const provider = config.provider;
  if (provider === "openai") return openAiProvider(config.openai, config.model);
  if (provider === "openai_compat") return openAiProvider(config.openaiCompat, config.model);
  if (provider === "anthropic") return anthropicProvider(config.anthropic, config.model);
  if (provider === "gemini") return geminiProvider(config.gemini, config.model);
  if (["openai_subscription", "openai_oauth", "chatgpt"].includes(provider)) {
    return codexCliProvider(config.openai, config.model);
  }
  if (["anthropic_subscription", "anthropic_oauth", "claude"].includes(provider)) {
    return unsupportedAccountProvider("Anthropic API calls require API keys. Claude subscriptions cannot be used as API credentials.");
  }
  throw new ProviderError(`Unsupported DEFAULT_AI_PROVIDER: ${provider}`);
}

function assertKey(apiKey, provider) {
  if (!hasRealKey(apiKey)) {
    throw new ProviderError(`Missing API key for ${provider}. Edit .env before running the agent.`);
  }
}

function unsupportedAccountProvider(message) {
  return {
    name: "unsupported-account-auth",
    async complete() {
      throw new ProviderError(message);
    }
  };
}

function codexCliProvider(options, model) {
  if (options.subscriptionClient !== "codex") {
    return unsupportedAccountProvider(`Unsupported OpenAI subscription client: ${options.subscriptionClient}`);
  }
  return {
    name: "codex-cli",
    async complete(messages, { allowTools = false } = {}) {
      return runCodexExec({
        command: options.codexCommand || "codex",
        model,
        timeoutMs: options.codexTimeoutMs || 180000,
        prompt: codexPrompt(messages, { allowTools })
      });
    }
  };
}

function openAiProvider(options, model) {
  return {
    name: "openai-compatible",
    async complete(messages, { temperature = 0.2 } = {}) {
      const headers = openAiHeaders(options);
      const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify({
          model,
          messages,
          temperature
        })
      });
      if (!response.ok) throw new ProviderError(await response.text());
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    }
  };
}

function runCodexExec({ command, model, timeoutMs, prompt }) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(os.tmpdir(), `llm-wiki-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const [bin, ...prefixArgs] = splitCommand(command);
    const args = [
      ...prefixArgs,
      "exec",
      "--model", model,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-last-message", outputFile,
      "-"
    ];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ProviderError(`Codex CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError(`Failed to start Codex CLI: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          reject(new ProviderError(`Codex CLI exited with code ${code}: ${cleanCodexOutput(stderr || stdout)}`));
          return;
        }
        const answer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : cleanCodexOutput(stdout);
        fs.rmSync(outputFile, { force: true });
        resolve(answer || cleanCodexOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function codexPrompt(messages, { allowTools = false } = {}) {
  const lines = [
    "You are answering inside a local Obsidian LLM Wiki agent.",
    allowTools
      ? "You may inspect read-only local files referenced in the prompt. Do not edit files. Return only the final answer for the user."
      : "Return only the final answer for the user. Do not edit files, run commands, or describe tool usage.",
    ""
  ];
  for (const message of messages) {
    lines.push(`## ${message.role.toUpperCase()}`);
    lines.push(message.content);
    lines.push("");
  }
  return lines.join("\n");
}

function splitCommand(command) {
  const parts = String(command || "codex").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : ["codex"];
}

function cleanCodexOutput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("WARNING: proceeding, even though we could not update PATH"))
    .join("\n")
    .trim();
}

function anthropicProvider(options, model) {
  return {
    name: "anthropic",
    async complete(messages, { temperature = 0.2 } = {}) {
      if (options.authMethod !== "api_key") {
        throw new ProviderError("Anthropic direct API authentication requires an API key. Claude subscription/OAuth login is not accepted by this API.");
      }
      assertKey(options.apiKey, "Anthropic");
      const system = messages.find((message) => message.role === "system")?.content || "";
      const userMessages = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content
        }));
      const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          system,
          messages: userMessages,
          max_tokens: 4000,
          temperature
        })
      });
      if (!response.ok) throw new ProviderError(await response.text());
      const data = await response.json();
      return data.content?.map((part) => part.text || "").join("") || "";
    }
  };
}

function geminiProvider(options, model) {
  return {
    name: "gemini",
    async complete(messages, { temperature = 0.2 } = {}) {
      const endpoint = `${options.baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const { url, headers } = geminiAuth(options, endpoint);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify({
          contents: geminiContents(messages),
          generationConfig: { temperature }
        })
      });
      if (!response.ok) throw new ProviderError(await response.text());
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    }
  };
}

function openAiHeaders(options) {
  const authMethod = options.authMethod || "api_key";
  if (authMethod === "oauth") {
    throw new ProviderError("OpenAI API calls require API keys. ChatGPT Plus/Pro/Team subscription login cannot be used as OAuth for this local API client.");
  }
  if (authMethod === "bearer") {
    assertKey(options.bearerToken, "OpenAI-compatible bearer token");
    return { authorization: `Bearer ${options.bearerToken}` };
  }
  assertKey(options.apiKey, "OpenAI/OpenAI-compatible");
  const headers = { authorization: `Bearer ${options.apiKey}` };
  if (options.organization) headers["OpenAI-Organization"] = options.organization;
  if (options.project) headers["OpenAI-Project"] = options.project;
  return headers;
}

function geminiAuth(options, endpoint) {
  if (options.authMethod === "oauth") {
    const token = readToken(options.oauthAccessToken, options.oauthTokenFile);
    assertKey(token, "Gemini OAuth access token");
    return { url: endpoint, headers: { authorization: `Bearer ${token}` } };
  }
  assertKey(options.apiKey, "Gemini");
  const separator = endpoint.includes("?") ? "&" : "?";
  return { url: `${endpoint}${separator}key=${encodeURIComponent(options.apiKey)}`, headers: {} };
}

function readToken(value, file) {
  if (hasRealKey(value)) return value.trim();
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return "";
}

function geminiContents(messages) {
  const system = messages.find((message) => message.role === "system")?.content || "";
  const rest = messages.filter((message) => message.role !== "system");
  return rest.map((message, index) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{
      text: index === 0 && system
        ? `System instructions:\n${system}\n\nUser message:\n${message.content}`
        : message.content
    }]
  }));
}
