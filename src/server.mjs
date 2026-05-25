import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deleteArchivedItems } from "./archive-delete.mjs";
import { restoreArchivedItems } from "./archive-restore.mjs";
import { backfillLearningSections } from "./backfill-learning-sections.mjs";
import { getConfig, setConfigFilePath } from "./config.mjs";
import { answerQuestion } from "./chat-lib.mjs";
import { saveChatAsRawSource } from "./chat-source.mjs";
import { listArchiveHistory, listFileHistory } from "./history.mjs";
import { ingestVault } from "./ingest-lib.mjs";
import { answerLocally } from "./local-answer.mjs";
import { addNote, deleteNote, listNotes, saveNoteMedia, updateNote } from "./notes.mjs";
import { createProvider } from "./provider.mjs";
import { providerStatus } from "./provider-status.mjs";
import { preflightStatus } from "./preflight.mjs";
import { listBridgeVaults, sharedSettingsForVault, sharedSettingsSummary, updateSharedSettingsForVault } from "./shared-settings.mjs";
import { deleteSources } from "./source-delete.mjs";
import { mergeSources } from "./source-merge.mjs";
import { renameSource } from "./source-rename.mjs";
import { topicContent } from "./topic-content.mjs";
import { listTopics } from "./topics.mjs";
import { listRawCandidates, listVaults, vaultName } from "./vaults.mjs";
import { bootstrapVault } from "./vault-bootstrap.mjs";

let config = getConfig();
let provider = createProvider(config);
let ingestRunning = false;
let lastIngestMessage = "Auto-ingest has not run yet.";
let ingestProgress = {
  percent: 0,
  completed: 0,
  total: 0,
  vault: "",
  detail: "Auto-ingest has not run yet."
};
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/help") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHelp());
    return;
  }

  if (request.method === "GET" && url.pathname === "/help-media") {
    try {
      const file = url.searchParams.get("file") || "";
      const media = resolveHelpMedia(file);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHelpMedia(file, media));
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderNotFound("That README media file could not be found."));
    }
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
    try {
      const media = resolveHelpMedia(url.pathname.slice("/media/".length));
      serveMediaFile(request, response, media);
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderNotFound("That README media file could not be found."));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/files") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ files: listFileHistory(config) }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/archives") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ archives: listArchiveHistory(config) }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/delete-archives") {
    try {
      const body = await readBody(request);
      const { items } = JSON.parse(body || "{}");
      const results = deleteArchivedItems(config, Array.isArray(items) ? items : []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/restore-archives") {
    try {
      const body = await readBody(request);
      const { items } = JSON.parse(body || "{}");
      const results = restoreArchivedItems(config, Array.isArray(items) ? items : []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/delete-sources") {
    try {
      const body = await readBody(request);
      const { sources } = JSON.parse(body || "{}");
      const results = deleteSources(config, Array.isArray(sources) ? sources : []);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/merge-sources") {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = mergeSources(config, payload);
      let archived = [];
      if (payload.originalAction === "archive") {
        archived = deleteSources(config, Array.isArray(payload.sources) ? payload.sources : []);
      }
      runAutoIngest();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result, archived }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/rename-source") {
    try {
      const body = await readBody(request);
      const result = renameSource(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/topics") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ topics: listTopics(config) }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/topic-content") {
    try {
      const answer = topicContent(config, {
        vault: url.searchParams.get("vault"),
        path: url.searchParams.get("path"),
        title: url.searchParams.get("title")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ingestRunning, lastIngestMessage, ingestProgress }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/provider-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(await providerStatus(config)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/vaults") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ vaults: listBridgeVaults(config) }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/shared-settings") {
    try {
      const vault = url.searchParams.get("vault");
      const payload = vault ? sharedSettingsForVault(config, vault) : { vaults: sharedSettingsSummary(config) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/shared-settings") {
    if (!authorizedBridgeRequest(request, response)) return;
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      const result = updateSharedSettingsForVault(config, payload.vault, payload.settings || {});
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config-path") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ configFile: config.configFile }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config-path") {
    try {
      const body = await readBody(request);
      const { path: selectedPath } = JSON.parse(body || "{}");
      if (!selectedPath || !fs.existsSync(selectedPath)) throw new Error("Choose an existing config file.");
      setConfigFilePath(selectedPath);
      reloadRuntimeConfig();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ configFile: config.configFile, status: "Config path updated." }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config-choose") {
    try {
      const selectedPath = await chooseConfigFile();
      if (!selectedPath) throw new Error("No config file selected.");
      setConfigFilePath(selectedPath);
      reloadRuntimeConfig();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ configFile: config.configFile, status: "Config path updated." }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/config-open") {
    try {
      await openConfigFile(config.configFile);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "Opened config file.", configFile: config.configFile }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/preflight") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(preflightStatus(config)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notes") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ notes: listNotes(config) }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes") {
    try {
      const body = await readBody(request);
      const note = addNote(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ note }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes/media") {
    try {
      const body = await readBody(request);
      const result = saveNoteMedia(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/vault-media") {
    try {
      const vault = url.searchParams.get("vault") || "";
      const file = url.searchParams.get("file") || "";
      const media = resolveVaultMedia(config, vault, file);
      serveMediaFile(request, response, media);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes/update") {
    try {
      const body = await readBody(request);
      const result = updateNote(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/notes/delete") {
    try {
      const body = await readBody(request);
      const { id } = JSON.parse(body || "{}");
      const result = deleteNote(config, String(id || ""));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask") {
    try {
      const body = await readBody(request);
      const { question } = JSON.parse(body || "{}");
      const answer = await answerQuestion(String(question || ""), config);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/complete") {
    if (!authorizedBridgeRequest(request, response)) return;
    try {
      const body = await readBody(request);
      const { prompt } = JSON.parse(body || "{}");
      const text = await provider.complete([
        { role: "system", content: "You are the Mac Bridge provider for LLM Wiki Agent. Return a useful, concise answer for the native iPhone/iPad client. Do not reveal secrets." },
        { role: "user", content: String(prompt || "") }
      ]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/save-chat-source") {
    try {
      const body = await readBody(request);
      const result = saveChatAsRawSource(config, JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/local-ask") {
    try {
      const body = await readBody(request);
      const { question } = JSON.parse(body || "{}");
      const answer = answerLocally(String(question || ""), config);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answer }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  response.end(renderNotFound("The page you opened is not available."));
});

server.listen(config.chatPort, config.bridgeHost, () => {
  console.log(`LLM Wiki chat UI: http://${config.bridgeHost}:${config.chatPort}`);
  startAutoIngest();
});

function startAutoIngest() {
  for (const vault of listVaults(config.vaultsRoot)) {
    bootstrapVault(vault, config);
  }
  const backfilled = backfillLearningSections(config);
  if (backfilled.length) {
    console.log(`[backfill] added learning sections to ${backfilled.length} wiki page${backfilled.length === 1 ? "" : "s"}`);
  }
  runAutoIngest();
  setInterval(runAutoIngest, config.watchIntervalMs);
}

function reloadRuntimeConfig() {
  config = getConfig();
  provider = createProvider(config);
  ingestProgress = {
    percent: 100,
    completed: 0,
    total: 0,
    vault: "",
    detail: "Config reloaded."
  };
  lastIngestMessage = `Config reloaded from ${config.configFile} at ${formatLocal(new Date())}.`;
}

function chooseConfigFile() {
  return runOsascript([
    "set chosenFile to choose file with prompt \"Choose LLM Wiki Agent config file\"",
    "POSIX path of chosenFile"
  ]);
}

function openConfigFile(file) {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "TextEdit", file], (error) => error ? reject(error) : resolve(""));
  });
}

function resolveVaultMedia(config, vault, file) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === vault);
  if (!vaultPath) throw new Error("Unknown vault.");
  const normalized = String(file || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid media path.");
  }
  const full = path.resolve(vaultPath, normalized);
  const root = path.resolve(vaultPath);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Invalid media path.");
  if (!fs.existsSync(full)) throw new Error("Media file not found.");
  return { file: full, contentType: mediaContentType(full) };
}

function resolveHelpMedia(file) {
  const normalized = decodeURIComponent(String(file || ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid media path.");
  }
  const roots = [
    path.join(agentRoot, "media"),
    path.resolve("media"),
    path.resolve("../media")
  ];
  for (const root of roots) {
    const full = path.resolve(root, normalized);
    if ((full === root || full.startsWith(root + path.sep)) && fs.existsSync(full)) {
      return { file: full, contentType: mediaContentType(full) };
    }
  }
  throw new Error("Media file not found.");
}

function serveMediaFile(request, response, media) {
  const stat = fs.statSync(media.file);
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, {
      "content-type": media.contentType,
      "content-length": stat.size,
      "accept-ranges": "bytes"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(media.file).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, {
      "content-range": `bytes */${stat.size}`,
      "accept-ranges": "bytes"
    });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    response.writeHead(416, {
      "content-range": `bytes */${stat.size}`,
      "accept-ranges": "bytes"
    });
    response.end();
    return;
  }
  const safeEnd = Math.min(end, stat.size - 1);
  response.writeHead(206, {
    "content-type": media.contentType,
    "content-length": safeEnd - start + 1,
    "content-range": `bytes ${start}-${safeEnd}/${stat.size}`,
    "accept-ranges": "bytes"
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(media.file, { start, end: safeEnd }).pipe(response);
}

function mediaContentType(file) {
  const ext = path.extname(file).toLowerCase();
  const types = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aiff": "audio/aiff",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v"
  };
  return types[ext] || "application/octet-stream";
}

function runOsascript(lines) {
  return new Promise((resolve, reject) => {
    const args = lines.flatMap((line) => ["-e", line]);
    execFile("osascript", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function runAutoIngest() {
  if (ingestRunning) return;
  ingestRunning = true;
  try {
    let count = 0;
    const vaults = listVaults(config.vaultsRoot);
    const candidateCounts = vaults.map((vault) => listRawCandidates(vault).length);
    const total = candidateCounts.reduce((sum, item) => sum + item, 0);
    let completed = 0;
    ingestProgress = {
      percent: total ? 0 : 100,
      completed,
      total,
      vault: "",
      detail: total ? "Auto-ingest started." : "No pending files."
    };
    for (const [index, vault] of vaults.entries()) {
      const bootstrapped = bootstrapVault(vault, config);
      if (bootstrapped.length) {
        console.log(`[bootstrap] ${vaultName(vault)}: ${bootstrapped.join(", ")}`);
      }
      ingestProgress = progressState({
        completed,
        total,
        vault: vaultName(vault),
        detail: `Scanning ${vaultName(vault)}.`
      });
      const results = await ingestVault(vault, config, provider);
      completed += candidateCounts[index];
      count += results.length;
      for (const result of results) {
        console.log(`[auto-ingest] ${result.vault}: ${result.source} -> ${result.sourcePage}`);
      }
      ingestProgress = progressState({
        completed,
        total,
        vault: vaultName(vault),
        detail: `Finished ${vaultName(vault)}.`
      });
    }
    lastIngestMessage = count
      ? `Progress: 100%. Processed ${count} file${count === 1 ? "" : "s"} at ${formatLocal(new Date())}.`
      : `Progress: 100%. No pending files at ${formatLocal(new Date())}.`;
    ingestProgress = progressState({
      completed: total,
      total,
      vault: "",
      detail: lastIngestMessage
    });
  } catch (error) {
    lastIngestMessage = `Progress: ${ingestProgress.percent || 0}%. Auto-ingest error at ${formatLocal(new Date())}: ${error.message}`;
    ingestProgress = {
      ...ingestProgress,
      detail: lastIngestMessage
    };
    console.error(`[auto-ingest] ${error.stack || error.message}`);
  } finally {
    ingestRunning = false;
  }
}

function progressState({ completed, total, vault, detail }) {
  const percent = total ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 100;
  return { percent, completed, total, vault, detail };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function authorizedBridgeRequest(request, response) {
  if (!config.bridgeToken) return true;
  const header = request.headers["x-llm-wiki-bridge-token"] || request.headers.authorization || "";
  const value = Array.isArray(header) ? header[0] : header;
  const token = String(value).replace(/^Bearer\s+/i, "");
  if (token === config.bridgeToken) return true;
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Unauthorized Mac Bridge request." }));
  return false;
}

function renderHtml() {
  const vaultOptions = listVaults(config.vaultsRoot)
    .map((vaultPath) => {
      const name = vaultName(vaultPath);
      return `<option value="${serverEscapeHtml(name)}">${serverEscapeHtml(name)}</option>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Wiki Agent</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --soft: #eef2f7; --muted: #697386; --accent: #1f5eff; --accent-text: #ffffff; --shadow: rgba(20, 32, 50, 0.08); --mark: #fff2a8; }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --soft: #273449; --muted: #9ca3af; --accent: #60a5fa; --accent-text: #07111f; --shadow: rgba(0, 0, 0, 0.28); --mark: #725f12; }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --soft: #eadfca; --muted: #75664f; --accent: #8a5a19; --accent-text: #ffffff; --shadow: rgba(80, 58, 28, 0.12); --mark: #ffe08a; }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --soft: #dcebe1; --muted: #55705f; --accent: #22734a; --accent-text: #ffffff; --shadow: rgba(24, 82, 53, 0.12); --mark: #c7f2a7; }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --soft: #eeeeee; --muted: #333333; --accent: #000000; --accent-text: #ffffff; --shadow: rgba(0, 0, 0, 0.2); --mark: #ffff00; }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --soft: #222838; --muted: #9aa8bd; --accent: #39d5ff; --accent-text: #061019; --shadow: rgba(0, 0, 0, 0.36); --mark: #705d17; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 920px; margin: 0 auto; padding: 32px 300px 32px 20px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    h1 { font-size: 24px; margin: 0; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    select { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); padding: 8px; }
    .help { color: var(--accent); text-decoration: none; font-weight: 650; }
    .tabs { position: sticky; top: 0; z-index: 16; display: flex; gap: 8px; border-bottom: 1px solid var(--line); margin-bottom: 18px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(12px); padding-top: 6px; }
    .tab { appearance: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; color: var(--muted); padding: 8px 10px; cursor: pointer; }
    .tab .status-dot { width: 8px; height: 8px; margin-right: 6px; box-shadow: none; vertical-align: 1px; }
    .tab.active { border-bottom-color: var(--accent); color: var(--text); font-weight: 700; }
    .panel { display: none; }
    .panel.active { display: block; }
    form { display: flex; gap: 8px; margin-bottom: 12px; }
    input, textarea { flex: 1; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); }
    textarea { min-height: 90px; width: 100%; box-sizing: border-box; resize: vertical; }
    button.primary { font: inherit; padding: 9px 12px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-text); cursor: pointer; }
    button.secondary { font: inherit; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: default; }
    .table-controls { display: grid; grid-template-columns: minmax(180px, 1fr) repeat(3, minmax(120px, auto)); gap: 8px; align-items: center; margin: 12px 0; }
    .table-controls input, .table-controls select { min-width: 0; width: 100%; box-sizing: border-box; }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable::after { content: " ↕"; color: var(--muted); font-weight: 400; }
    th.sortable.sort-asc::after { content: " ↑"; color: var(--accent); }
    th.sortable.sort-desc::after { content: " ↓"; color: var(--accent); }
    .result-tools { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 6px; margin: -4px 0 8px; }
    .chat-controls form { flex: 1 1 100%; }
    .chat-controls .result-tools { justify-content: flex-end; }
    .sticky-controls { position: sticky; top: 48px; z-index: 14; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(12px); padding: 8px; border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 8px 18px var(--shadow); margin-bottom: 12px; }
    .sticky-controls form, .sticky-controls .result-tools, .sticky-controls .table-controls { position: static; flex: 1 1 auto; margin: 0; padding: 0; border: 0; box-shadow: none; background: transparent; }
    .sticky-controls .result-tools { justify-content: flex-start; }
    .sticky-controls .table-controls { display: flex; flex-wrap: wrap; }
    .sticky-controls .table-controls input { flex: 1 1 260px; }
    .sticky-controls .table-controls select { flex: 0 1 180px; }
    .copy-feedback { color: var(--muted); font-size: 13px; min-width: 54px; }
    .answer { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px; min-height: 260px; line-height: 1.5; direction: auto; text-align: start; overflow-wrap: anywhere; }
    .answer [dir="auto"], .answer [dir="rtl"], .answer [dir="ltr"] { text-align: start; }
    .answer [data-align="right"] { text-align: right; }
    .answer [data-align="left"] { text-align: left; }
    .answer p { margin: 0 0 12px; }
    .answer ul, .answer ol { margin-top: 0; padding-inline-start: 1.4em; padding-inline-end: 0; list-style-position: outside; }
    .answer li { overflow-wrap: anywhere; }
    .answer li.qa-question { margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--line) 72%, transparent); }
    .answer li.qa-question:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
    .answer li.qa-answer { margin-top: 4px; margin-inline-start: 1.2em; }
    .local-result-body > ul, .local-nested-body > ul { box-sizing: border-box; max-width: 100%; overflow-wrap: anywhere; list-style-position: outside; padding-inline-start: 1.4em; padding-inline-end: 0; }
    .local-result-body > ul > li, .local-nested-body > ul > li { margin: 0 0 4px; }
    .local-result-body h1, .local-result-body h2, .local-result-body h3 { margin: 16px 0 8px; }
    .local-result-body h1:first-child, .local-result-body h2:first-child, .local-result-body h3:first-child { margin-top: 0; }
    .local-result-body[dir="rtl"] > ul, .local-result-body[data-align="right"] > ul, .local-nested-body[dir="rtl"] > ul, .local-nested-body[data-align="right"] > ul { padding-inline-start: 0; padding-inline-end: 1.4em; list-style-position: outside; }
    .local-result-body[dir="ltr"] > ul, .local-result-body[data-align="left"] > ul, .local-nested-body[dir="ltr"] > ul, .local-nested-body[data-align="left"] > ul { padding-inline-start: 1.4em; padding-inline-end: 0; list-style-position: outside; }
    .answer hr.result-separator { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
    .local-display-tools { justify-content: flex-start; margin-top: 0; }
    .local-tree { display: grid; gap: 10px; }
    .local-tree-vault { border-left: 3px solid var(--line); padding-left: 12px; }
    .local-tree-type { margin-left: 10px; border-left: 1px solid var(--line); padding-left: 12px; }
    details.local-result { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; max-width: 100%; box-sizing: border-box; overflow: clip; }
    details.local-result > summary { cursor: pointer; padding: 10px 12px; font-weight: 700; }
    .local-result-body { background: var(--panel); border-top: 1px solid var(--line); padding: 12px; overflow: clip; max-width: 100%; box-sizing: border-box; }
    details.local-nested { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; max-width: 100%; box-sizing: border-box; overflow: clip; }
    details.local-nested > summary { cursor: pointer; padding: 8px 10px; font-weight: 700; background: var(--soft); }
    .local-nested-body { padding: 10px 12px; border-top: 1px solid var(--line); overflow: clip; max-width: 100%; box-sizing: border-box; }
    .local-result-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .local-result-title, .local-nested-title { min-width: 0; }
    .dir-controls { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
    .dir-button { font: inherit; font-size: 11px; line-height: 1; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); padding: 3px 6px; cursor: pointer; }
    .dir-button:hover, .dir-button.active { color: var(--text); border-color: var(--accent); background: var(--soft); }
    .local-result-count { color: var(--muted); font-size: 12px; font-weight: 500; margin-left: 6px; }
    mark.agent-highlight { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 2px; }
    .note-anchor { color: inherit; }
    .note-indicator { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 4px; border: 1px solid var(--line); border-radius: 999px; color: var(--accent); background: var(--soft); vertical-align: super; cursor: help; user-select: none; -webkit-user-select: none; }
    .note-indicator::before { content: ""; display: block; width: 5px; height: 5px; border-radius: 999px; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 16%, transparent); }
    .note-indicator.has-media::before { width: 6px; height: 6px; border-radius: 2px; }
    .note-popover { display: none; position: fixed; z-index: 2000; min-width: 240px; max-width: min(420px, calc(100vw - 48px)); max-height: min(480px, calc(100vh - 48px)); overflow: auto; white-space: normal; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 18px 44px var(--shadow); padding: 10px; font-size: 13px; line-height: 1.35; }
    .note-popover.visible { display: block; }
    .note-popover p { margin: 0 0 8px; }
    .note-popover p:last-child { margin-bottom: 0; }
    .note-popover img, .note-popover video, .note-popover iframe { display: block; max-width: 100%; max-height: 240px; border-radius: 4px; border: 1px solid var(--line); background: var(--soft); margin: 8px 0; }
    .note-popover audio { display: block; width: 100%; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
    th { background: var(--soft); font-weight: 700; }
    tr:last-child td { border-bottom: 0; }
    .muted { color: var(--muted); }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
    .side-topics { position: fixed; top: 20px; right: 20px; width: 250px; max-height: calc(100vh - 40px); overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px; box-shadow: 0 12px 30px var(--shadow); }
    .side-topic-controls { position: sticky; top: -14px; z-index: 5; background: var(--panel); padding: 14px 0 10px; margin-top: -14px; border-bottom: 1px solid var(--line); }
    .side-topics h2 { margin: 0 0 10px; font-size: 15px; }
    .side-topic-search-row { display: flex; gap: 6px; margin-bottom: 10px; }
    .side-topic-search { min-width: 0; width: 100%; box-sizing: border-box; padding: 9px 10px; }
    .side-topic-clear { flex: 0 0 34px; width: 34px; padding: 0; text-align: center; }
    .side-topic-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .side-topic-filters select, .side-topic-filters input { width: 100%; min-width: 0; box-sizing: border-box; padding: 7px; font-size: 13px; }
    .side-topic-filters .wide { grid-column: 1 / -1; }
    .side-topic-meta { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .side-topics button { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 7px 4px; color: var(--text); cursor: pointer; border-radius: 4px; }
    .side-topics button:hover { background: var(--soft); }
    .status { font-size: 13px; color: var(--muted); margin: -6px 0 16px; }
    .provider-state { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 12px; font-weight: 700; }
    .status-dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; background: var(--muted); box-shadow: 0 0 0 3px var(--soft); }
    .status-dot.green { background: #16a34a; }
    .status-dot.orange { background: #f59e0b; }
    .status-dot.red { background: #dc2626; }
    .status-dot.grey { background: #9ca3af; }
    .selection-toolbar { position: fixed; display: none; z-index: 20; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 12px 30px var(--shadow); padding: 6px; }
    .snap-overlay { position: fixed; inset: 0; display: none; z-index: 40; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.76); padding: 32px; box-sizing: border-box; }
    .snap-box { width: min(920px, 92vw); max-height: 82vh; overflow: auto; background: #05070c; color: #f8fbff; border: 2px solid var(--snap-border, #70e6ff); border-radius: 8px; padding: 28px; box-shadow: 0 0 28px color-mix(in srgb, var(--snap-border, #70e6ff) 60%, transparent), inset 0 0 18px rgba(255, 255, 255, 0.08); animation: snap-spark 1.2s linear infinite; }
    .snap-text { white-space: pre-wrap; line-height: 1.45; font-size: var(--snap-size, 34px); font-weight: 750; letter-spacing: 0; }
    .snap-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; color: #d8f7ff; }
    .snap-controls input { flex: 0 1 260px; accent-color: #70e6ff; }
    @keyframes snap-spark {
      0%, 100% { border-color: var(--snap-border, #70e6ff); box-shadow: 0 0 20px color-mix(in srgb, var(--snap-border, #70e6ff) 50%, transparent), inset 0 0 18px rgba(255, 255, 255, 0.08); }
      50% { border-color: #ffffff; box-shadow: 0 0 36px rgba(255, 255, 255, 0.72), 0 0 54px rgba(57, 213, 255, 0.38), inset 0 0 24px rgba(112, 230, 255, 0.12); }
    }
    .note-editor { display: none; position: fixed; z-index: 21; width: min(460px, calc(100vw - 24px)); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 12px 30px var(--shadow); padding: 10px; }
    .note-tools { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 6px; align-items: center; margin-top: 8px; }
    .note-tools input { min-width: 0; }
    .note-media-label { display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; cursor: pointer; }
    .note-media-label input { display: none; }
    .note-actions, .note-row-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .notes-list { margin-top: 18px; }
    .note-card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
    .note-card.focused { animation: note-focus 1.4s ease-out; border-color: var(--accent); box-shadow: 0 0 0 3px var(--soft); }
    @keyframes note-focus {
      0% { transform: translateY(-4px); box-shadow: 0 0 0 5px var(--mark); }
      45% { transform: translateY(0); box-shadow: 0 0 0 3px var(--mark); }
      100% { box-shadow: 0 0 0 3px var(--soft); }
    }
    .source-ref { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
    .config-path-row { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
    .config-path-row input { min-width: 0; }
    @media (max-width: 1180px) {
      main { padding-right: 20px; }
      .side-topics { position: static; width: auto; max-height: 220px; margin: 0 20px 20px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>LLM Wiki Agent</h1>
      <div class="header-actions">
        <label class="muted" for="theme-select">Theme</label>
        <select id="theme-select">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="sepia">Sepia</option>
          <option value="forest">Forest</option>
          <option value="contrast">Contrast</option>
          <option value="megatron">Megatron</option>
        </select>
        <a class="help" href="/help">Help</a>
      </div>
    </header>
    <nav class="tabs">
      <button class="tab active" data-tab="chat" type="button">Chat</button>
      <button class="tab" data-tab="local" type="button">Local</button>
      <button class="tab" data-tab="files" type="button">Files</button>
      <button class="tab" data-tab="archives" type="button">Archive</button>
      <button class="tab" data-tab="topics" type="button">Topics</button>
      <button class="tab" data-tab="provider" type="button"><span id="provider-tab-dot" class="status-dot grey"></span>Provider</button>
      <button class="tab" data-tab="notes" type="button">Notes</button>
    </nav>
    <p id="status" class="status">Checking auto-ingest status...</p>
    <section id="chat-panel" class="panel active">
      <div class="sticky-controls chat-controls">
        <form id="form">
          <input id="question" autocomplete="off" placeholder="Ask about your vaults">
          <button id="ask" class="primary" type="submit">Ask</button>
          <button id="clear-chat" class="secondary" type="button">Clear</button>
        </form>
        <div class="result-tools">
          <label class="muted" for="chat-save-vault">Save to</label>
          <select id="chat-save-vault">${vaultOptions}</select>
          <button id="save-chat-source" class="secondary" type="button">Save as raw source</button>
          <span id="save-chat-feedback" class="copy-feedback"></span>
          <select id="chat-copy-format">
            <option value="text">Pure text</option>
            <option value="html">Formatted text</option>
            <option value="markdown">Markdown</option>
          </select>
          <button id="copy-chat" class="secondary" type="button">Copy</button>
          <span id="chat-copy-feedback" class="copy-feedback"></span>
        </div>
      </div>
      <div id="answer" class="answer">Ready.</div>
    </section>
    <section id="local-panel" class="panel">
      <p class="muted">Local mode searches stored wiki markdown only. It does not call an AI provider and does not connect to the internet.</p>
      <div class="sticky-controls">
        <form id="local-form">
          <input id="local-question" autocomplete="off" placeholder="Ask locally without AI or internet">
          <button id="local-ask" class="primary" type="submit">Search</button>
          <button id="clear-local" class="secondary" type="button">Clear</button>
        </form>
        <div class="result-tools local-display-tools">
          <label class="muted" for="local-result-view">View</label>
          <select id="local-result-view">
            <option value="combined">Tree + accordion</option>
            <option value="accordion">Accordion</option>
            <option value="plain">Plain</option>
          </select>
          <label class="muted" for="local-result-expand">Start</label>
          <select id="local-result-expand">
            <option value="first">First result expanded</option>
            <option value="collapsed">Collapsed</option>
            <option value="expanded">Expanded</option>
          </select>
          <select id="local-copy-format">
            <option value="text">Pure text</option>
            <option value="html">Formatted text</option>
            <option value="markdown">Markdown</option>
          </select>
          <button id="copy-local" class="secondary" type="button">Copy</button>
          <span id="local-copy-feedback" class="copy-feedback"></span>
        </div>
      </div>
      <div id="local-answer" class="answer">Ready for local search.</div>
    </section>
    <section id="files-panel" class="panel">
      <p class="muted">Received and processed files are shown in local time.</p>
      <div class="sticky-controls">
        <div class="result-tools">
          <button id="rename-source" class="secondary" type="button">Rename selected source</button>
          <button id="merge-sources" class="secondary" type="button">Merge selected sources</button>
          <button id="delete-sources" class="secondary" type="button">Archive selected sources</button>
          <span id="rename-source-feedback" class="copy-feedback"></span>
          <span id="merge-sources-feedback" class="copy-feedback"></span>
          <span id="delete-sources-feedback" class="copy-feedback"></span>
        </div>
        <div class="table-controls">
          <input id="files-filter" autocomplete="off" placeholder="Filter files">
          <select id="files-vault-filter"><option value="">All vaults</option></select>
          <select id="files-status-filter"><option value="">All statuses</option></select>
          <button id="files-clear-filter" class="secondary" type="button">Clear</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th class="sortable" data-table="files" data-sort="number">#</th>
            <th class="sortable" data-table="files" data-sort="vault">Vault</th>
            <th class="sortable" data-table="files" data-sort="file">File</th>
            <th class="sortable" data-table="files" data-sort="receivedAtMs">Received</th>
            <th class="sortable" data-table="files" data-sort="processedAtMs">Processed</th>
            <th class="sortable" data-table="files" data-sort="status">Status</th>
          </tr>
        </thead>
        <tbody id="files-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="archives-panel" class="panel">
      <p class="muted">Archived raw sources and archived wiki pages. These are removed from active wiki navigation but preserved on disk.</p>
      <div class="sticky-controls">
        <div class="result-tools">
          <button id="restore-archives" class="secondary" type="button">Restore selected archived items</button>
          <button id="delete-archives" class="secondary" type="button">Delete selected archived items</button>
          <span id="restore-archives-feedback" class="copy-feedback"></span>
          <span id="delete-archives-feedback" class="copy-feedback"></span>
        </div>
        <div class="table-controls">
          <input id="archives-filter" autocomplete="off" placeholder="Filter archives">
          <select id="archives-vault-filter"><option value="">All vaults</option></select>
          <select id="archives-kind-filter"><option value="">All types</option></select>
          <button id="archives-clear-filter" class="secondary" type="button">Clear</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th class="sortable" data-table="archives" data-sort="number">#</th>
            <th class="sortable" data-table="archives" data-sort="vault">Vault</th>
            <th class="sortable" data-table="archives" data-sort="kind">Type</th>
            <th class="sortable" data-table="archives" data-sort="relation">Relation</th>
            <th class="sortable" data-table="archives" data-sort="file">Path</th>
            <th class="sortable" data-table="archives" data-sort="archivedAtMs">Archived</th>
          </tr>
        </thead>
        <tbody id="archives-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="topics-panel" class="panel">
      <p class="muted">All available wiki topics and insights with their vault paths.</p>
      <div class="table-controls">
        <input id="topics-filter" autocomplete="off" placeholder="Filter topics">
        <select id="topics-vault-filter"><option value="">All vaults</option></select>
        <select id="topics-type-filter"><option value="">All types</option></select>
        <button id="topics-clear-filter" class="secondary" type="button">Clear</button>
      </div>
      <table>
        <thead>
          <tr>
            <th class="sortable" data-table="topics" data-sort="number">#</th>
            <th class="sortable" data-table="topics" data-sort="title">Topic</th>
            <th class="sortable" data-table="topics" data-sort="type">Type</th>
            <th class="sortable" data-table="topics" data-sort="vault">Vault</th>
            <th class="sortable" data-table="topics" data-sort="path">Path</th>
            <th class="sortable" data-table="topics" data-sort="tagsText">Tags</th>
            <th class="sortable" data-table="topics" data-sort="updated">Updated</th>
          </tr>
        </thead>
        <tbody id="topics-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="provider-panel" class="panel">
      <p class="muted">Current AI provider configuration. Secret values are hidden.</p>
      <div class="result-tools">
        <button id="refresh-provider" class="secondary" type="button">Refresh</button>
        <button id="open-config-file" class="secondary" type="button">Open config</button>
        <button id="choose-config-file" class="secondary" type="button">Choose config file</button>
        <span id="config-path-feedback" class="copy-feedback"></span>
      </div>
      <div class="config-path-row">
        <input id="config-path-input" autocomplete="off" placeholder="Config file path">
        <button id="save-config-path" class="secondary" type="button">Use path</button>
      </div>
      <div id="provider-status-box" class="answer">Loading provider status...</div>
    </section>
    <section id="notes-panel" class="panel">
      <p class="muted">User notes added from highlighted answer text. Notes are also written into markdown files for Obsidian.</p>
      <div class="sticky-controls">
      <div class="result-tools">
        <label class="muted" for="note-display-mode">Hover note display</label>
        <select id="note-display-mode">
          <option value="box">Note box</option>
          <option value="tooltip">Browser tooltip</option>
        </select>
      <button id="refresh-notes" class="secondary" type="button">Refresh</button>
      </div>
      </div>
      <div id="notes-list" class="notes-list">Loading...</div>
    </section>
  </main>
  <aside class="side-topics">
    <div class="side-topic-controls">
      <h2>Topics & Insights</h2>
      <div class="side-topic-search-row">
        <input id="side-topic-search" class="side-topic-search" autocomplete="off" placeholder="Search title, tag, date, area, concept">
        <button id="side-topic-clear" class="secondary side-topic-clear" type="button" title="Clear topic search">x</button>
      </div>
      <div class="side-topic-filters">
        <select id="side-topic-type" title="Filter by wiki element">
          <option value="">All elements</option>
        </select>
        <input id="side-topic-tag" autocomplete="off" placeholder="Tag">
        <input id="side-topic-from" type="date" title="Updated from">
        <input id="side-topic-to" type="date" title="Updated to">
      </div>
    </div>
    <div id="topic-list" class="muted">Loading...</div>
  </aside>
  <div id="selection-toolbar" class="selection-toolbar">
    <button id="sel-highlight" class="secondary" type="button">Highlight</button>
    <button id="sel-snap" class="secondary" type="button">Snap</button>
    <button id="sel-copy-text" class="secondary" type="button">Copy text</button>
    <button id="sel-copy-html" class="secondary" type="button">Copy formatted</button>
    <button id="sel-copy-md" class="secondary" type="button">Copy MD</button>
    <button id="sel-note" class="secondary" type="button">Add note</button>
  </div>
  <div id="note-editor" class="note-editor">
    <div class="muted">Note for selected text</div>
    <textarea id="note-text" placeholder="Write a note"></textarea>
    <div class="note-tools">
      <input id="note-link-text" autocomplete="off" placeholder="Link text">
      <input id="note-link-url" autocomplete="off" placeholder="https://...">
      <button id="note-insert-link" class="secondary" type="button">Add link</button>
      <label class="secondary note-media-label">Add media<input id="note-media" type="file" accept="image/*,.pdf,audio/*,video/*"></label>
    </div>
    <div id="note-media-feedback" class="copy-feedback"></div>
    <div class="note-actions">
      <button id="note-cancel" class="secondary" type="button">Cancel</button>
      <button id="note-save" class="primary" type="button">Save</button>
    </div>
  </div>
  <div id="note-popover" class="note-popover" role="note"></div>
  <div id="snap-overlay" class="snap-overlay">
    <div class="snap-box">
      <div class="snap-controls">
        <strong>Snap</strong>
        <label>Size <input id="snap-size" type="range" min="24" max="72" value="34"></label>
        <button id="snap-close" class="secondary" type="button">Close</button>
      </div>
      <div id="snap-text" class="snap-text"></div>
    </div>
  </div>
  <script>
    const form = document.querySelector("#form");
    const input = document.querySelector("#question");
    const button = document.querySelector("#ask");
    const clearChat = document.querySelector("#clear-chat");
    const answer = document.querySelector("#answer");
    const copyChat = document.querySelector("#copy-chat");
    const chatCopyFormat = document.querySelector("#chat-copy-format");
    const chatCopyFeedback = document.querySelector("#chat-copy-feedback");
    const chatSaveVault = document.querySelector("#chat-save-vault");
    const saveChatSource = document.querySelector("#save-chat-source");
    const saveChatFeedback = document.querySelector("#save-chat-feedback");
    const localForm = document.querySelector("#local-form");
    const localInput = document.querySelector("#local-question");
    const localButton = document.querySelector("#local-ask");
    const clearLocal = document.querySelector("#clear-local");
    const localAnswer = document.querySelector("#local-answer");
    const copyLocal = document.querySelector("#copy-local");
    const localCopyFormat = document.querySelector("#local-copy-format");
    const localCopyFeedback = document.querySelector("#local-copy-feedback");
    const localResultView = document.querySelector("#local-result-view");
    const localResultExpand = document.querySelector("#local-result-expand");
    const tabs = document.querySelectorAll(".tab");
    const filesBody = document.querySelector("#files-body");
    const filesFilter = document.querySelector("#files-filter");
    const filesVaultFilter = document.querySelector("#files-vault-filter");
    const filesStatusFilter = document.querySelector("#files-status-filter");
    const filesClearFilter = document.querySelector("#files-clear-filter");
    const archivesBody = document.querySelector("#archives-body");
    const archivesFilter = document.querySelector("#archives-filter");
    const archivesVaultFilter = document.querySelector("#archives-vault-filter");
    const archivesKindFilter = document.querySelector("#archives-kind-filter");
    const archivesClearFilter = document.querySelector("#archives-clear-filter");
    const renameSourceButton = document.querySelector("#rename-source");
    const renameSourceFeedback = document.querySelector("#rename-source-feedback");
    const mergeSourcesButton = document.querySelector("#merge-sources");
    const mergeSourcesFeedback = document.querySelector("#merge-sources-feedback");
    const deleteSourcesButton = document.querySelector("#delete-sources");
    const deleteSourcesFeedback = document.querySelector("#delete-sources-feedback");
    const deleteArchivesButton = document.querySelector("#delete-archives");
    const deleteArchivesFeedback = document.querySelector("#delete-archives-feedback");
    const restoreArchivesButton = document.querySelector("#restore-archives");
    const restoreArchivesFeedback = document.querySelector("#restore-archives-feedback");
    const topicsBody = document.querySelector("#topics-body");
    const topicsFilter = document.querySelector("#topics-filter");
    const topicsVaultFilter = document.querySelector("#topics-vault-filter");
    const topicsTypeFilter = document.querySelector("#topics-type-filter");
    const topicsClearFilter = document.querySelector("#topics-clear-filter");
    const providerStatusBox = document.querySelector("#provider-status-box");
    const refreshProvider = document.querySelector("#refresh-provider");
    const providerTabDot = document.querySelector("#provider-tab-dot");
    const configPathInput = document.querySelector("#config-path-input");
    const saveConfigPath = document.querySelector("#save-config-path");
    const chooseConfigFile = document.querySelector("#choose-config-file");
    const openConfigFile = document.querySelector("#open-config-file");
    const configPathFeedback = document.querySelector("#config-path-feedback");
    const topicList = document.querySelector("#topic-list");
    const sideTopicSearch = document.querySelector("#side-topic-search");
    const sideTopicClear = document.querySelector("#side-topic-clear");
    const sideTopicType = document.querySelector("#side-topic-type");
    const sideTopicTag = document.querySelector("#side-topic-tag");
    const sideTopicFrom = document.querySelector("#side-topic-from");
    const sideTopicTo = document.querySelector("#side-topic-to");
    const statusEl = document.querySelector("#status");
    const themeSelect = document.querySelector("#theme-select");
    const selectionToolbar = document.querySelector("#selection-toolbar");
    const noteEditor = document.querySelector("#note-editor");
    const notePopover = document.querySelector("#note-popover");
    const noteText = document.querySelector("#note-text");
    const noteLinkText = document.querySelector("#note-link-text");
    const noteLinkUrl = document.querySelector("#note-link-url");
    const noteInsertLink = document.querySelector("#note-insert-link");
    const noteMedia = document.querySelector("#note-media");
    const noteMediaFeedback = document.querySelector("#note-media-feedback");
    const snapOverlay = document.querySelector("#snap-overlay");
    const snapText = document.querySelector("#snap-text");
    const snapSize = document.querySelector("#snap-size");
    const snapClose = document.querySelector("#snap-close");
    const notesList = document.querySelector("#notes-list");
    const refreshNotes = document.querySelector("#refresh-notes");
    const noteDisplayMode = document.querySelector("#note-display-mode");
    let lastChatMarkdown = "";
    let lastLocalMarkdown = "";
    let selectedInfo = null;
    let notesCache = [];
    let notePopoverTimer = null;
    let sideTopicsCache = [];
    let filesCache = [];
    let archivesCache = [];
    let topicsCache = [];
    const tableSort = {
      files: { key: "processedAtMs", dir: "desc" },
      archives: { key: "archivedAtMs", dir: "desc" },
      topics: { key: "title", dir: "asc" }
    };

    const savedTheme = localStorage.getItem("llm-wiki-theme") || "light";
    document.body.dataset.theme = savedTheme;
    themeSelect.value = savedTheme;
    themeSelect.addEventListener("change", () => {
      document.body.dataset.theme = themeSelect.value;
      localStorage.setItem("llm-wiki-theme", themeSelect.value);
    });

    const savedNoteDisplay = localStorage.getItem("llm-wiki-note-display") || "box";
    document.body.dataset.noteDisplay = savedNoteDisplay;
    noteDisplayMode.value = savedNoteDisplay;
    noteDisplayMode.addEventListener("change", () => {
      document.body.dataset.noteDisplay = noteDisplayMode.value;
      localStorage.setItem("llm-wiki-note-display", noteDisplayMode.value);
      hideNotePopover();
      refreshResultAnnotations();
    });

    const savedSnapSize = localStorage.getItem("llm-wiki-snap-size") || "34";
    snapSize.value = savedSnapSize;
    snapOverlay.style.setProperty("--snap-size", savedSnapSize + "px");
    snapSize.addEventListener("input", () => {
      snapOverlay.style.setProperty("--snap-size", snapSize.value + "px");
      localStorage.setItem("llm-wiki-snap-size", snapSize.value);
    });
    snapClose.addEventListener("click", closeSnap);
    snapOverlay.addEventListener("click", (event) => {
      if (event.target === snapOverlay) closeSnap();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && snapOverlay.style.display === "flex") closeSnap();
    });

    localResultView.value = localStorage.getItem("llm-wiki-local-result-view") || "combined";
    localResultExpand.value = localStorage.getItem("llm-wiki-local-result-expand") || "first";
    localResultView.addEventListener("change", () => {
      localStorage.setItem("llm-wiki-local-result-view", localResultView.value);
      renderLocalResultBox();
    });
    localResultExpand.addEventListener("change", () => {
      localStorage.setItem("llm-wiki-local-result-expand", localResultExpand.value);
      renderLocalResultBox();
    });

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((item) => item.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
        tab.classList.add("active");
        document.querySelector("#" + tab.dataset.tab + "-panel").classList.add("active");
        if (tab.dataset.tab === "files") loadFiles();
        if (tab.dataset.tab === "archives") loadArchives();
        if (tab.dataset.tab === "topics") loadTopics();
        if (tab.dataset.tab === "provider") loadProviderStatus();
        if (tab.dataset.tab === "notes") loadNotes();
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      answer.textContent = "Thinking...";
      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: input.value })
        });
        const data = await response.json();
        lastChatMarkdown = data.answer || data.error || "No answer.";
        answer.innerHTML = renderMarkdown(lastChatMarkdown);
        applyAutoDirection(answer);
        selectCitedVault(lastChatMarkdown);
        applyNoteAnnotations(answer);
      } catch (error) {
        answer.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });

    localForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await runLocalSearch();
    });

    async function runLocalSearch() {
      localButton.disabled = true;
      localAnswer.textContent = "Searching stored wiki pages...";
      try {
        const response = await fetch("/api/local-ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: localInput.value })
        });
        const data = await response.json();
        lastLocalMarkdown = data.answer || data.error || "No answer.";
        renderLocalResultBox();
      } catch (error) {
        localAnswer.textContent = error.message;
      } finally {
        localButton.disabled = false;
      }
    }

    copyChat.addEventListener("click", () => copyResult(answer, lastChatMarkdown, chatCopyFormat.value, chatCopyFeedback));
    saveChatSource.addEventListener("click", saveChatAsSource);
    copyLocal.addEventListener("click", () => copyResult(localAnswer, lastLocalMarkdown, localCopyFormat.value, localCopyFeedback));
    clearChat.addEventListener("click", () => clearChatResult());
    clearLocal.addEventListener("click", () => clearLocalResult());
    renameSourceButton.addEventListener("click", renameSelectedSource);
    mergeSourcesButton.addEventListener("click", mergeSelectedSources);
    deleteSourcesButton.addEventListener("click", deleteSelectedSources);
    deleteArchivesButton.addEventListener("click", deleteSelectedArchives);
    restoreArchivesButton.addEventListener("click", restoreSelectedArchives);
    sideTopicSearch.addEventListener("input", renderSideTopics);
    sideTopicType.addEventListener("change", renderSideTopics);
    sideTopicTag.addEventListener("input", renderSideTopics);
    sideTopicFrom.addEventListener("change", renderSideTopics);
    sideTopicTo.addEventListener("change", renderSideTopics);
    sideTopicClear.addEventListener("click", () => {
      sideTopicSearch.value = "";
      sideTopicType.value = "";
      sideTopicTag.value = "";
      sideTopicFrom.value = "";
      sideTopicTo.value = "";
      renderSideTopics();
      sideTopicSearch.focus();
    });
    refreshProvider.addEventListener("click", loadProviderStatus);
    saveConfigPath.addEventListener("click", saveConfigPathValue);
    chooseConfigFile.addEventListener("click", chooseConfigPathValue);
    openConfigFile.addEventListener("click", openConfigPathValue);
    refreshNotes.addEventListener("click", loadNotes);
    filesFilter.addEventListener("input", renderFilesTable);
    filesVaultFilter.addEventListener("change", renderFilesTable);
    filesStatusFilter.addEventListener("change", renderFilesTable);
    filesClearFilter.addEventListener("click", () => {
      filesFilter.value = "";
      filesVaultFilter.value = "";
      filesStatusFilter.value = "";
      renderFilesTable();
    });
    archivesFilter.addEventListener("input", renderArchivesTable);
    archivesVaultFilter.addEventListener("change", renderArchivesTable);
    archivesKindFilter.addEventListener("change", renderArchivesTable);
    archivesClearFilter.addEventListener("click", () => {
      archivesFilter.value = "";
      archivesVaultFilter.value = "";
      archivesKindFilter.value = "";
      renderArchivesTable();
    });
    topicsFilter.addEventListener("input", renderTopicsTable);
    topicsVaultFilter.addEventListener("change", renderTopicsTable);
    topicsTypeFilter.addEventListener("change", renderTopicsTable);
    topicsClearFilter.addEventListener("click", () => {
      topicsFilter.value = "";
      topicsVaultFilter.value = "";
      topicsTypeFilter.value = "";
      renderTopicsTable();
    });
    document.querySelectorAll("th.sortable").forEach((header) => {
      header.addEventListener("click", () => {
        const table = header.dataset.table;
        const key = header.dataset.sort;
        tableSort[table].dir = tableSort[table].key === key && tableSort[table].dir === "asc" ? "desc" : "asc";
        tableSort[table].key = key;
        if (table === "files") renderFilesTable();
        if (table === "archives") renderArchivesTable();
        if (table === "topics") renderTopicsTable();
      });
    });

    async function saveChatAsSource() {
      const question = input.value.trim();
      const answerMarkdown = lastChatMarkdown.trim();
      if (!question || !answerMarkdown) {
        saveChatFeedback.textContent = "Question and answer required";
        setTimeout(() => { saveChatFeedback.textContent = ""; }, 1800);
        return;
      }
      saveChatSource.disabled = true;
      saveChatFeedback.textContent = "Saving...";
      try {
        const response = await fetch("/api/save-chat-source", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vault: chatSaveVault.value, question, answer: answerMarkdown })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        saveChatFeedback.textContent = "Saved to " + data.file;
        loadStatus();
      } catch (error) {
        saveChatFeedback.textContent = error.message;
      } finally {
        saveChatSource.disabled = false;
        setTimeout(() => { saveChatFeedback.textContent = ""; }, 3600);
      }
    }

    function selectCitedVault(markdown) {
      const match = String(markdown).match(/\\b([A-Za-z0-9_-]+-vault)\\s+\\/\\s+wiki\\//);
      if (!match) return;
      const option = Array.from(chatSaveVault.options).find((item) => item.value === match[1]);
      if (option) chatSaveVault.value = option.value;
    }

    async function loadFiles() {
      filesBody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
      try {
        const response = await fetch("/api/files");
        const data = await response.json();
        filesCache = data.files || [];
        populateSelect(filesVaultFilter, filesCache.map((file) => file.vault), "All vaults");
        populateSelect(filesStatusFilter, filesCache.map((file) => file.status), "All statuses");
        renderFilesTable();
      } catch (error) {
        filesBody.innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
      }
    }

    function renderFilesTable() {
      updateSortHeaders("files");
      const files = sortRows(filterRows(filesCache, filesFilter.value, ["number", "vault", "file", "sourcePage", "receivedAt", "processedAt", "status"])
        .filter((file) => !filesVaultFilter.value || file.vault === filesVaultFilter.value)
        .filter((file) => !filesStatusFilter.value || file.status === filesStatusFilter.value), "files");
      if (!filesCache.length) {
        filesBody.innerHTML = '<tr><td colspan="7" class="muted">No processed files yet.</td></tr>';
        return;
      }
      if (!files.length) {
        filesBody.innerHTML = '<tr><td colspan="7" class="muted">No files match the current filters.</td></tr>';
        return;
      }
      filesBody.innerHTML = files.map((file) => '<tr>' +
        '<td><input class="source-select" type="checkbox" data-vault="' + escapeHtml(file.vault) + '" data-file="' + escapeHtml(file.file) + '" data-source-page="' + escapeHtml(file.sourcePage || "") + '"></td>' +
        '<td>' + escapeHtml(file.number) + '</td>' +
        '<td>' + escapeHtml(file.vault) + '</td>' +
        '<td><div class="path">' + escapeHtml(file.file) + '</div><div class="muted path">' + escapeHtml(file.sourcePage || "") + '</div></td>' +
        '<td>' + escapeHtml(file.receivedAt) + '</td>' +
        '<td>' + escapeHtml(file.processedAt) + '</td>' +
        '<td>' + escapeHtml(file.status) + '</td>' +
      '</tr>').join("");
    }

    async function deleteSelectedSources() {
      const selected = selectedSourceItems();
      if (!selected.length) {
        deleteSourcesFeedback.textContent = "Select a source first";
        setTimeout(() => { deleteSourcesFeedback.textContent = ""; }, 1600);
        return;
      }
      const confirmed = window.confirm("Archive selected source files and source pages, then remove them from active index/wiki references?");
      if (!confirmed) return;
      deleteSourcesButton.disabled = true;
      deleteSourcesFeedback.textContent = "Archiving...";
      try {
        const response = await fetch("/api/delete-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sources: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const archivedCount = (data.results || []).reduce((sum, item) => sum + (item.archived || []).length, 0);
        deleteSourcesFeedback.textContent = archivedCount
          ? "Archived " + archivedCount + " related file" + (archivedCount === 1 ? "" : "s")
          : "No matching files found to archive";
        await loadFiles();
        loadArchives();
        loadTopics();
        loadSideTopics();
      } catch (error) {
        deleteSourcesFeedback.textContent = error.message;
      } finally {
        deleteSourcesButton.disabled = false;
        setTimeout(() => { deleteSourcesFeedback.textContent = ""; }, 2200);
      }
    }

    async function renameSelectedSource() {
      const selected = selectedSourceItems();
      if (selected.length !== 1) {
        renameSourceFeedback.textContent = "Select exactly one source";
        setTimeout(() => { renameSourceFeedback.textContent = ""; }, 1800);
        return;
      }
      const current = selected[0].sourcePage || selected[0].file || "source";
      const title = window.prompt("New source title", titleFromPath(current));
      if (!title) return;
      renameSourceButton.disabled = true;
      renameSourceFeedback.textContent = "Renaming...";
      try {
        const response = await fetch("/api/rename-source", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...selected[0], title })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const changed = [
          data.result.raw?.to,
          data.result.sourcePage?.to
        ].filter(Boolean).join(", ");
        renameSourceFeedback.textContent = changed ? "Renamed to " + changed : "Rename completed";
        await loadFiles();
        loadTopics();
        loadSideTopics();
      } catch (error) {
        renameSourceFeedback.textContent = error.message;
      } finally {
        renameSourceButton.disabled = false;
        setTimeout(() => { renameSourceFeedback.textContent = ""; }, 3600);
      }
    }

    async function mergeSelectedSources() {
      const selected = selectedSourceItems();
      if (selected.length < 2) {
        mergeSourcesFeedback.textContent = "Select at least two sources";
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 1800);
        return;
      }
      const vaults = [...new Set(selected.map((item) => item.vault))];
      if (vaults.length !== 1) {
        mergeSourcesFeedback.textContent = "Select sources from one vault";
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 2200);
        return;
      }
      const title = window.prompt("Merged source title", "Merged source from " + selected.length + " sources");
      if (!title) return;
      const archiveOriginals = window.confirm("After creating the merged source, archive the original selected sources and remove them from active wiki references?\\n\\nChoose OK to archive originals, or Cancel to keep them active.");
      mergeSourcesButton.disabled = true;
      mergeSourcesFeedback.textContent = "Merging...";
      try {
        const response = await fetch("/api/merge-sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sources: selected,
            title,
            originalAction: archiveOriginals ? "archive" : "keep"
          })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        const archivedCount = (data.archived || []).reduce((sum, item) => sum + (item.archived || []).length, 0);
        mergeSourcesFeedback.textContent = "Merged to " + data.result.file + (archiveOriginals ? "; archived " + archivedCount + " files" : "; originals kept");
        await loadFiles();
        loadArchives();
        loadTopics();
        loadSideTopics();
        loadStatus();
      } catch (error) {
        mergeSourcesFeedback.textContent = error.message;
      } finally {
        mergeSourcesButton.disabled = false;
        setTimeout(() => { mergeSourcesFeedback.textContent = ""; }, 4200);
      }
    }

    function selectedSourceItems() {
      return Array.from(document.querySelectorAll(".source-select:checked")).map((item) => ({
        vault: item.dataset.vault,
        file: item.dataset.file,
        sourcePage: item.dataset.sourcePage
      }));
    }

    function titleFromPath(value) {
      const base = String(value).split("/").pop().replace(/\\.[^.]+$/, "").replace(/^\\d{4}-\\d{2}-\\d{2}--/, "");
      return base.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Renamed source";
    }

    function populateSelect(select, values, label) {
      const current = select.value;
      const options = [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
      select.innerHTML = '<option value="">' + escapeHtml(label) + '</option>' +
        options.map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join("");
      if (options.includes(current)) select.value = current;
    }

    function filterRows(rows, query, keys) {
      const text = String(query || "").trim().toLowerCase();
      if (!text) return rows.slice();
      return rows.filter((row) => keys.some((key) => String(row[key] || "").toLowerCase().includes(text)));
    }

    function sortRows(rows, table) {
      const { key, dir } = tableSort[table];
      const direction = dir === "asc" ? 1 : -1;
      return rows.slice().sort((a, b) => compareValues(a[key], b[key]) * direction);
    }

    function compareValues(a, b) {
      const left = a ?? "";
      const right = b ?? "";
      if (typeof left === "number" && typeof right === "number") return left - right;
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && String(left).trim() !== "" && String(right).trim() !== "") {
        return leftNumber - rightNumber;
      }
      return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    }

    function updateSortHeaders(table) {
      document.querySelectorAll('th.sortable[data-table="' + table + '"]').forEach((header) => {
        header.classList.toggle("sort-asc", header.dataset.sort === tableSort[table].key && tableSort[table].dir === "asc");
        header.classList.toggle("sort-desc", header.dataset.sort === tableSort[table].key && tableSort[table].dir === "desc");
      });
    }

    async function loadArchives() {
      archivesBody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
      try {
        const response = await fetch("/api/archives");
        const data = await response.json();
        archivesCache = data.archives || [];
        populateSelect(archivesVaultFilter, archivesCache.map((item) => item.vault), "All vaults");
        populateSelect(archivesKindFilter, archivesCache.map((item) => item.kind), "All types");
        renderArchivesTable();
      } catch (error) {
        archivesBody.innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
      }
    }

    function renderArchivesTable() {
      updateSortHeaders("archives");
      const archives = sortRows(filterRows(archivesCache, archivesFilter.value, ["number", "vault", "kind", "relation", "file", "archivedAt"])
        .filter((item) => !archivesVaultFilter.value || item.vault === archivesVaultFilter.value)
        .filter((item) => !archivesKindFilter.value || item.kind === archivesKindFilter.value), "archives");
      if (!archivesCache.length) {
        archivesBody.innerHTML = '<tr><td colspan="7" class="muted">No archived sources yet.</td></tr>';
        return;
      }
      if (!archives.length) {
        archivesBody.innerHTML = '<tr><td colspan="7" class="muted">No archived items match the current filters.</td></tr>';
        return;
      }
      archivesBody.innerHTML = archives.map((item) => '<tr>' +
        '<td><input class="archive-select" type="checkbox" data-vault="' + escapeHtml(item.vault) + '" data-file="' + escapeHtml(item.file) + '" data-relation="' + escapeHtml(item.relation || "") + '"></td>' +
        '<td>' + escapeHtml(item.number) + '</td>' +
        '<td>' + escapeHtml(item.vault) + '</td>' +
        '<td>' + escapeHtml(item.kind) + '</td>' +
        '<td>' + escapeHtml(item.relation || "Archive-only item") + '</td>' +
        '<td class="path">' + escapeHtml(item.file) + '</td>' +
        '<td>' + escapeHtml(item.archivedAt) + '</td>' +
      '</tr>').join("");
    }

    async function restoreSelectedArchives() {
      const selected = selectedArchiveItems();
      if (!selected.length) {
        restoreArchivesFeedback.textContent = "Select archived items first";
        setTimeout(() => { restoreArchivesFeedback.textContent = ""; }, 1600);
        return;
      }
      restoreArchivesButton.disabled = true;
      restoreArchivesFeedback.textContent = "Restoring...";
      try {
        const response = await fetch("/api/restore-archives", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        restoreArchivesFeedback.textContent = "Restored";
        await loadArchives();
        loadFiles();
        loadTopics();
        loadSideTopics();
      } catch (error) {
        restoreArchivesFeedback.textContent = error.message;
      } finally {
        restoreArchivesButton.disabled = false;
        setTimeout(() => { restoreArchivesFeedback.textContent = ""; }, 2200);
      }
    }

    async function deleteSelectedArchives() {
      const selected = selectedArchiveItems();
      if (!selected.length) {
        deleteArchivesFeedback.textContent = "Select archived items first";
        setTimeout(() => { deleteArchivesFeedback.textContent = ""; }, 1600);
        return;
      }
      const relations = [...new Set(selected.map((item) => item.relation).filter(Boolean))].join(", ");
      const confirmed = window.confirm("Permanently delete selected archived files? This cannot be undone from the app." + (relations ? "\\n\\nRelated: " + relations : ""));
      if (!confirmed) return;
      deleteArchivesButton.disabled = true;
      deleteArchivesFeedback.textContent = "Deleting...";
      try {
        const response = await fetch("/api/delete-archives", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: selected })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        deleteArchivesFeedback.textContent = "Deleted";
        await loadArchives();
      } catch (error) {
        deleteArchivesFeedback.textContent = error.message;
      } finally {
        deleteArchivesButton.disabled = false;
        setTimeout(() => { deleteArchivesFeedback.textContent = ""; }, 2200);
      }
    }

    function selectedArchiveItems() {
      return Array.from(document.querySelectorAll(".archive-select:checked")).map((item) => ({
        vault: item.dataset.vault,
        file: item.dataset.file,
        relation: item.dataset.relation
      }));
    }

    async function loadTopics() {
      topicsBody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
      try {
        const response = await fetch("/api/topics");
        const data = await response.json();
        topicsCache = (data.topics || []).map((topic, index) => ({ ...topic, number: index + 1, tagsText: (topic.tags || []).join(", ") }));
        populateSelect(topicsVaultFilter, topicsCache.map((topic) => topic.vault), "All vaults");
        populateSelect(topicsTypeFilter, topicsCache.map((topic) => topic.type), "All types");
        renderTopicsTable();
      } catch (error) {
        topicsBody.innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
      }
    }

    function renderTopicsTable() {
      updateSortHeaders("topics");
      const topics = sortRows(filterRows(topicsCache, topicsFilter.value, ["number", "title", "summary", "type", "vault", "path", "tagsText", "updated"])
        .filter((topic) => !topicsVaultFilter.value || topic.vault === topicsVaultFilter.value)
        .filter((topic) => !topicsTypeFilter.value || topic.type === topicsTypeFilter.value), "topics");
      if (!topicsCache.length) {
        topicsBody.innerHTML = '<tr><td colspan="7" class="muted">No topics yet.</td></tr>';
        return;
      }
      if (!topics.length) {
        topicsBody.innerHTML = '<tr><td colspan="7" class="muted">No topics match the current filters.</td></tr>';
        return;
      }
      topicsBody.innerHTML = topics.map((topic, index) => '<tr>' +
        '<td>' + escapeHtml(topic.number || index + 1) + '</td>' +
        '<td>' + escapeHtml(topic.title) + '<div class="muted">' + escapeHtml(topic.summary || "") + '</div></td>' +
        '<td>' + escapeHtml(topic.type) + '</td>' +
        '<td>' + escapeHtml(topic.vault) + '</td>' +
        '<td class="path">' + escapeHtml(topic.path) + '</td>' +
        '<td>' + escapeHtml(topic.tagsText || "") + '</td>' +
        '<td>' + escapeHtml(topic.updated) + '</td>' +
      '</tr>').join("");
    }

    async function loadProviderStatus() {
      providerStatusBox.textContent = "Loading provider status...";
      try {
        const [providerResponse, sharedResponse] = await Promise.all([
          fetch("/api/provider-status"),
          fetch("/api/shared-settings")
        ]);
        const data = await providerResponse.json();
        const sharedData = await sharedResponse.json();
        updateProviderTabStatus(data.statusColor, data.status, data.statusDetail);
        configPathInput.value = data.configFile || "";
        const rows = [
          ["Config file", data.configFile],
          ["Provider", data.provider],
          ["Model", data.model],
          ["Bridge transport", data.transport],
          ["Access method", data.accessMethod],
          ["Auth method", data.authMethod],
          ["Credential", data.credentialConfigured ? "configured" : "not configured"],
          ["Status detail", data.statusDetail || ""]
        ];
        const sharedRows = (sharedData.vaults || []).flatMap((item) => {
          const settings = item.settings || {};
          const provider = settings.provider || {};
          const display = settings.display || {};
          const search = settings.search || {};
          return [
            [item.vault + " provider", provider.mode || ""],
            [item.vault + " transport", provider.transport || ""],
            [item.vault + " model", provider.defaultModel || ""],
            [item.vault + " theme", display.theme || ""],
            [item.vault + " local results", search.localResultView || ""]
          ];
        });
        providerStatusBox.innerHTML = '<h2>Current Provider</h2>' +
          '<div class="provider-state"><span class="status-dot ' + escapeHtml(data.statusColor || "grey") + '"></span><span>' + escapeHtml(data.status || "Unknown") + '</span></div>' +
          '<table><tbody>' + rows.map(([label, value]) =>
            '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value || "") + '</td></tr>'
          ).join("") + '</tbody></table>' +
          '<h3>Shared Agent Settings</h3>' +
          '<table><tbody>' + sharedRows.map(([label, value]) =>
            '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value || "") + '</td></tr>'
          ).join("") + '</tbody></table>' +
          '<h3>Details</h3>' +
          '<table><tbody>' + (data.details || []).map((item) =>
            '<tr><th>' + escapeHtml(item.label) + '</th><td>' + escapeHtml(item.value) + '</td></tr>'
          ).join("") + '</tbody></table>' +
          '<h3>Safety</h3><ul>' + (data.safety || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>';
      } catch (error) {
        providerStatusBox.textContent = error.message;
      }
    }

    async function saveConfigPathValue() {
      await updateConfigPath("/api/config-path", { path: configPathInput.value.trim() });
    }

    async function chooseConfigPathValue() {
      await updateConfigPath("/api/config-choose");
    }

    async function openConfigPathValue() {
      await updateConfigPath("/api/config-open");
    }

    async function updateConfigPath(endpoint, body) {
      configPathFeedback.textContent = "Working...";
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : "{}"
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (data.configFile) configPathInput.value = data.configFile;
        configPathFeedback.textContent = data.status || "Done";
        await loadProviderStatus();
      } catch (error) {
        configPathFeedback.textContent = error.message;
      } finally {
        setTimeout(() => { configPathFeedback.textContent = ""; }, 3200);
      }
    }

    function updateProviderTabStatus(color, label, detail) {
      providerTabDot.className = "status-dot " + sanitizeStatusColor(color);
      providerTabDot.title = [label || "Unknown", detail || ""].filter(Boolean).join(": ");
    }

    function sanitizeStatusColor(color) {
      return ["green", "orange", "red", "grey"].includes(color) ? color : "grey";
    }

    async function loadSideTopics() {
      try {
        const response = await fetch("/api/topics");
        const data = await response.json();
        sideTopicsCache = (data.topics || []).filter((topic) => !isScaffoldTopic(topic));
        renderTopicTypeOptions();
        renderSideTopics();
      } catch (error) {
        topicList.textContent = error.message;
      }
    }

    function renderSideTopics() {
      const query = sideTopicSearch.value.trim().toLowerCase();
      const selectedType = sideTopicType.value;
      const selectedTag = sideTopicTag.value.trim().toLowerCase().replace(/^#/, "");
      const from = sideTopicFrom.value;
      const to = sideTopicTo.value;
      const topics = sideTopicsCache
        .filter((topic) => {
          if (selectedType && !topicMatchesType(topic, selectedType)) return false;
          const tags = topic.tags || [];
          if (selectedTag && !tags.some((tag) => String(tag).toLowerCase().replace(/^#/, "").includes(selectedTag))) return false;
          if (from && String(topic.updated || "") < from) return false;
          if (to && String(topic.updated || "") > to) return false;
          if (!query) return true;
          return [topic.title, topic.summary, topic.type, topic.vault, topic.updated, topic.created, topic.path, ...tags]
            .some((value) => String(value || "").toLowerCase().includes(query));
        })
        .slice(0, 120);
      if (!topics.length) {
        topicList.textContent = sideTopicsCache.length ? "No matching topics." : "No topics yet.";
        return;
      }
      topicList.innerHTML = topics.map((topic) =>
        '<button type="button" data-title="' + escapeHtml(topic.title) + '" data-vault="' + escapeHtml(topic.vault) + '" data-path="' + escapeHtml(topic.path) + '" title="' + escapeHtml(topic.summary || "") + '">' + escapeHtml(topic.title) + '<span class="side-topic-meta">' + escapeHtml(topic.type || "") + (topic.updated ? " | " + escapeHtml(topic.updated) : "") + '</span></button>'
      ).join("");
      topicList.querySelectorAll("button").forEach((item) => {
        item.addEventListener("click", () => openSideTopic(item));
      });
    }

    function renderTopicTypeOptions() {
      const current = sideTopicType.value;
      const wikiTypes = ["archive", "areas", "concepts", "entities", "info", "maps", "projects", "questions", "sources", "synthesis"];
      const observed = sideTopicsCache.map((topic) => topic.type).filter(Boolean);
      const types = [...new Set([...wikiTypes, ...observed])].sort();
      sideTopicType.innerHTML = '<option value="">All elements</option>' + types.map((type) =>
        '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>'
      ).join("");
      if (types.includes(current)) sideTopicType.value = current;
    }

    function topicMatchesType(topic, selectedType) {
      const aliases = {
        archive: ["archive", "archived"],
        areas: ["area", "areas"],
        concepts: ["concept", "concepts"],
        entities: ["entity", "entities"],
        info: ["info", "information"],
        maps: ["map", "maps"],
        projects: ["project", "projects"],
        questions: ["question", "questions"],
        sources: ["source", "sources"],
        synthesis: ["synthesis"]
      };
      const values = aliases[selectedType] || [selectedType];
      const type = String(topic.type || "").toLowerCase();
      const path = String(topic.path || "").toLowerCase();
      return values.includes(type) || values.some((value) => path.includes("/" + value + "/") || path.startsWith("wiki/" + value + "/"));
    }

    async function openSideTopic(item) {
      const title = item.dataset.title;
      const question = "Tell me about " + title;
      const hasSearchText = Boolean(input.value.trim() || localInput.value.trim());
      const hasResultContent = Boolean(lastChatMarkdown.trim() || lastLocalMarkdown.trim());
      if (hasSearchText || hasResultContent) {
        input.value = "";
        localInput.value = "";
        answer.textContent = "Ready.";
        localAnswer.textContent = "Ready for local search.";
        lastChatMarkdown = "";
        lastLocalMarkdown = "";
        hideSelectionTools();
      }
      input.value = question;
      localInput.value = title;
      activateTab("local");
      localAnswer.textContent = "Loading topic content...";
      try {
        const params = new URLSearchParams({
          vault: item.dataset.vault,
          path: item.dataset.path,
          title
        });
        const response = await fetch("/api/topic-content?" + params.toString());
        const data = await response.json();
        lastLocalMarkdown = data.answer || data.error || "No topic content.";
        renderLocalResultBox();
      } catch (error) {
        localAnswer.textContent = error.message;
      }
    }

    function activateTab(name) {
      tabs.forEach((item) => item.classList.toggle("active", item.dataset.tab === name));
      document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
      document.querySelector("#" + name + "-panel").classList.add("active");
    }

    function isScaffoldTopic(topic) {
      const path = String(topic.path || "").toLowerCase();
      const title = String(topic.title || "").toLowerCase();
      return path.includes("llm-wiki") ||
        path.includes("second-brain") ||
        path.includes("source-traceability") ||
        path.includes("persistent-synthesis") ||
        path.includes("wiki-maintenance-loop") ||
        title === "llm wiki" ||
        title === "llm wiki home" ||
        title === "llm wiki operating model" ||
        title === "second brain" ||
        title === "source traceability" ||
        title === "persistent synthesis" ||
        title === "wiki maintenance loop" ||
        title === "how should this vault operate?";
    }

    async function loadStatus() {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();
        const progress = data.ingestProgress || {};
        const percent = Number.isFinite(progress.percent) ? progress.percent : (data.ingestRunning ? 0 : 100);
        statusEl.textContent = "Progress: " + percent + "%. " + (data.lastIngestMessage || progress.detail || "Auto-ingest is running.");
      } catch (error) {
        statusEl.textContent = error.message;
      }
    }

    function renderMarkdown(markdown) {
      const lines = String(markdown).split(/\\r?\\n/);
      const html = [];
      let inList = false;
      let sectionCount = 0;
      for (const line of lines) {
        if (/^\\s*[-*]\\s+/.test(line)) {
          if (!inList) {
            html.push("<ul>");
            inList = true;
          }
          const item = line.replace(/^\\s*[-*]\\s+/, "");
          html.push('<li class="' + listItemClass(item) + '">' + inlineMarkdown(item) + "</li>");
          continue;
        }
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        if (/^[A-Za-z0-9_-]+-vault\\s+\\/\\s+wiki\\/.+/.test(line)) {
          if (sectionCount > 0 && html[html.length - 1] !== '<hr class="result-separator">') html.push('<hr class="result-separator">');
          html.push("<p class=\\"source-ref\\">" + inlineMarkdown(line) + "</p>");
        }
        else if (/^###\\s+/.test(line)) html.push("<h3>" + inlineMarkdown(line.replace(/^###\\s+/, "")) + "</h3>");
        else if (/^##\\s+/.test(line)) {
          if (sectionCount > 0) html.push('<hr class="result-separator">');
          sectionCount += 1;
          html.push("<h2>" + inlineMarkdown(line.replace(/^##\\s+/, "")) + "</h2>");
        }
        else if (/^#\\s+/.test(line)) html.push("<h1>" + inlineMarkdown(line.replace(/^#\\s+/, "")) + "</h1>");
        else if (line.trim()) html.push("<p>" + inlineMarkdown(line) + "</p>");
      }
      if (inList) html.push("</ul>");
      return html.join("");
    }

    function renderLocalResultBox() {
      if (!lastLocalMarkdown) {
        localAnswer.textContent = "Ready for local search.";
        return;
      }
      if (localResultView.value === "plain") {
        localAnswer.innerHTML = renderMarkdown(lastLocalMarkdown);
      } else {
        localAnswer.innerHTML = renderLocalStructured(lastLocalMarkdown);
      }
      applyAutoDirection(localAnswer);
      applyNoteAnnotations(localAnswer);
    }

    localAnswer.addEventListener("click", (event) => {
      const button = event.target.closest?.(".dir-button");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const nested = button.closest(".local-nested");
      const details = nested || button.closest(".local-result");
      const dir = button.dataset.dir || "auto";
      if (!details) return;
      const align = dir === "rtl" ? "right" : dir === "ltr" ? "left" : "";
      details.querySelectorAll(".dir-button").forEach((item) => item.classList.toggle("active", item === button));
      const body = nested ? details.querySelector(".local-nested-body") : details.querySelector(".local-result-body");
      const title = nested ? details.querySelector(".local-nested-title") : details.querySelector(".local-result-title");
      setNodeDirection(body, dir, align);
      setNodeDirection(title, dir, align);
      body?.querySelectorAll("p, li, h1, h2, h3, h4").forEach((item) => setNodeDirection(item, dir, align));
    });

    function renderLocalStructured(markdown) {
      const parsed = parseLocalResults(markdown);
      if (!parsed.results.length) return renderMarkdown(markdown);
      const before = parsed.intro ? '<p class="muted">' + inlineMarkdown(parsed.intro) + '</p>' : "";
      const after = parsed.footer ? '<p class="muted">' + inlineMarkdown(parsed.footer) + '</p>' : "";
      const body = localResultView.value === "accordion"
        ? renderLocalAccordion(parsed.results)
        : renderLocalCombined(parsed.results);
      return before + body + after;
    }

    function parseLocalResults(markdown) {
      const lines = String(markdown || "").split(/\\r?\\n/);
      const intro = [];
      const results = [];
      const footer = [];
      let current = null;
      let mode = "intro";
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const heading = line.match(/^##\\s+(.+)$/);
        if (heading && isLocalResultHeading(lines, i)) {
          if (current) results.push(current);
          current = { title: heading[1].trim(), ref: "", body: [] };
          mode = "result";
          continue;
        }
        if (mode === "result" && current) {
          if (!current.ref && isLocalSourceRef(line.trim())) {
            current.ref = line.trim();
          } else if (/^This answer was generated locally/i.test(line.trim())) {
            footer.push(line.trim());
            mode = "footer";
          } else if (current.ref) {
            current.body.push(line);
          }
        } else if (mode === "intro") {
          if (line.trim()) intro.push(line.trim());
        } else if (line.trim()) {
          footer.push(line.trim());
        }
      }
      if (current) results.push(current);
      return {
        intro: intro.join(" "),
        results,
        footer: footer.join(" ")
      };
    }

    function isLocalResultHeading(lines, index) {
      for (let i = index + 1; i < lines.length; i += 1) {
        const next = lines[i].trim();
        if (!next) continue;
        return isLocalSourceRef(next);
      }
      return false;
    }

    function isLocalSourceRef(value) {
      return /^[A-Za-z0-9_-]+-vault\\s+\\/\\s+wiki\\/.+/.test(String(value || "").trim());
    }

    function renderLocalAccordion(results) {
      return results.map((result, index) => renderLocalResultDetails(result, index)).join("");
    }

    function renderLocalCombined(results) {
      const groups = new Map();
      for (const result of results) {
        const ref = parseSourceRef(result.ref);
        const vault = ref.vault || "Unknown vault";
        const type = ref.type || "wiki";
        if (!groups.has(vault)) groups.set(vault, new Map());
        if (!groups.get(vault).has(type)) groups.get(vault).set(type, []);
        groups.get(vault).get(type).push(result);
      }
      let index = 0;
      const html = [];
      for (const [vault, types] of groups) {
        html.push('<div class="local-tree"><div class="local-tree-vault"><h3>' + escapeHtml(vault) + '</h3>');
        for (const [type, items] of types) {
          html.push('<div class="local-tree-type"><h4>' + escapeHtml(type) + '<span class="local-result-count">' + items.length + '</span></h4>');
          for (const item of items) {
            html.push(renderLocalResultDetails(item, index));
            index += 1;
          }
          html.push('</div>');
        }
        html.push('</div></div>');
      }
      return html.join("");
    }

    function renderLocalResultDetails(result, index) {
      const open = shouldOpenLocalResult(index) ? " open" : "";
      const body = result.body.join("\\n").trim();
      return '<details class="local-result"' + open + '>' +
        '<summary><span class="local-result-heading"><span class="local-result-title" dir="auto">' + escapeHtml(result.title) + '</span>' + renderDirectionControls() + '</span></summary>' +
        '<div class="local-result-body" dir="auto">' +
        (result.ref ? '<p class="source-ref" dir="ltr">' + inlineMarkdown(result.ref) + '</p>' : '') +
        (body ? renderNestedPageContent(body) : '<p class="muted">No readable page content found.</p>') +
        '</div></details>';
    }

    function renderNestedPageContent(markdown) {
      const lines = String(markdown || "").split(/\\r?\\n/);
      const intro = [];
      const sections = [];
      let current = null;
      for (const line of lines) {
        const heading = line.match(/^##\\s+(.+)$/);
        if (heading) {
          if (current) sections.push(current);
          current = { title: heading[1].trim(), lines: [] };
        } else if (current) {
          current.lines.push(line);
        } else {
          intro.push(line);
        }
      }
      if (current) sections.push(current);
      if (!sections.length) return renderMarkdown(markdown);
      const introHtml = intro.join("\\n").trim() ? renderMarkdown(intro.join("\\n")) : "";
      const sectionsHtml = sections.map((section, index) => {
        const open = index === 0 ? " open" : "";
        const body = section.lines.join("\\n").trim();
        return '<details class="local-nested"' + open + '>' +
          '<summary><span class="local-result-heading"><span class="local-nested-title" dir="auto">' + inlineMarkdown(section.title) + '</span>' + renderDirectionControls() + '</span></summary>' +
          '<div class="local-nested-body" dir="auto">' +
          (body ? renderMarkdown(body) : '<p class="muted">No content in this section.</p>') +
          '</div></details>';
      }).join("");
      return introHtml + sectionsHtml;
    }

    function renderDirectionControls() {
      return '<span class="dir-controls" aria-label="Text direction">' +
        '<button class="dir-button active" type="button" data-dir="auto" title="Auto direction">Auto</button>' +
        '<button class="dir-button" type="button" data-dir="rtl" title="Right to left">RTL</button>' +
        '<button class="dir-button" type="button" data-dir="ltr" title="Left to right">LTR</button>' +
      '</span>';
    }

    function applyAutoDirection(root) {
      root.setAttribute("dir", "auto");
      root.style.textAlign = "start";
      root.removeAttribute("data-align");
      root.querySelectorAll("p, li, h1, h2, h3, h4, summary, .local-result-body, .local-result-title").forEach((node) => {
        if (!node.hasAttribute("dir")) node.setAttribute("dir", "auto");
        if (!node.dataset.align) node.style.textAlign = "start";
      });
    }

    function setNodeDirection(node, dir, align) {
      if (!node) return;
      node.setAttribute("dir", dir);
      if (align) {
        node.dataset.align = align;
        node.style.textAlign = align;
      } else {
        delete node.dataset.align;
        node.style.textAlign = "start";
      }
    }

    function shouldOpenLocalResult(index) {
      if (localResultExpand.value === "expanded") return true;
      if (localResultExpand.value === "first") return index === 0;
      return false;
    }

    function parseSourceRef(ref) {
      const parts = String(ref || "").split("/").map((part) => part.trim()).filter(Boolean);
      return {
        vault: parts[0] || "",
        type: parts[2] || "",
        path: parts.slice(1).join("/")
      };
    }

    function inlineMarkdown(value) {
      return escapeHtml(value)
        .replace(/\\[\\[([^|\\]]+)\\|([^\\]]+)\\]\\]/g, "$2")
        .replace(/\\[\\[([^\\]]+)\\]\\]/g, "$1")
        .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
        .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
        .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, "$1");
    }

    function listItemClass(value) {
      if (/^Q:\\s*/i.test(String(value || ""))) return "qa-question";
      if (/^A:\\s*/i.test(String(value || ""))) return "qa-answer";
      return "";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeRegExp(value) {
      return String(value).replace(new RegExp("[.*+?^" + "$" + "{}()|[\\\\]\\\\\\\\]", "g"), "\\$&");
    }

    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        return;
      }
      const node = selection.anchorNode;
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const box = element?.closest?.(".answer");
      if (!box) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      selectedInfo = selectionInfo(selection, box);
      selectionToolbar.style.left = Math.max(12, rect.left) + "px";
      selectionToolbar.style.top = Math.max(12, rect.top - 48) + "px";
      selectionToolbar.style.display = "flex";
    });

    document.addEventListener("mousedown", (event) => {
      if (event.target.closest("#selection-toolbar") || event.target.closest("#note-editor") || event.target.closest("#note-popover")) return;
      hideNotePopover();
      hideSelectionTools();
    });

    document.querySelector("#sel-highlight").addEventListener("click", () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const existing = selectedHighlight(range) || closestHighlight(selection.anchorNode);
      if (existing) {
        unwrapHighlight(existing);
        selection.removeAllRanges();
        hideSelectionTools();
        return;
      }
      const indicatorNodes = selectedNoteIndicators(range);
      indicatorNodes.forEach((node) => node.remove());
      const mark = document.createElement("mark");
      mark.className = "agent-highlight";
      try {
        range.surroundContents(mark);
      } catch {
        mark.appendChild(range.extractContents());
        range.insertNode(mark);
      }
      selection.removeAllRanges();
      hideSelectionTools();
    });
    document.querySelector("#sel-snap").addEventListener("click", showSnap);
    document.querySelector("#sel-copy-text").addEventListener("click", () => copySelected("text"));
    document.querySelector("#sel-copy-html").addEventListener("click", () => copySelected("html"));
    document.querySelector("#sel-copy-md").addEventListener("click", () => copySelected("markdown"));
    document.querySelector("#sel-note").addEventListener("click", () => {
      if (!selectedInfo) return;
      const rect = selectionToolbar.getBoundingClientRect();
      noteEditor.style.left = Math.max(12, rect.left) + "px";
      noteEditor.style.top = Math.max(12, rect.bottom + 8) + "px";
      noteText.value = "";
      noteLinkText.value = "";
      noteLinkUrl.value = "";
      noteMedia.value = "";
      noteMediaFeedback.textContent = "";
      noteEditor.style.display = "block";
      noteText.focus();
    });
    document.querySelector("#note-cancel").addEventListener("click", () => {
      noteEditor.style.display = "none";
    });
    document.querySelector("#note-save").addEventListener("click", saveSelectedNote);
    noteInsertLink.addEventListener("click", insertNoteLink);
    noteMedia.addEventListener("change", uploadNoteMedia);
    noteText.addEventListener("paste", pasteNoteMedia);

    function showSnap() {
      const text = selectedInfo?.text || window.getSelection()?.toString()?.trim() || "";
      if (!text) return;
      if (window.webkit?.messageHandlers?.snap) {
        window.webkit.messageHandlers.snap.postMessage({ text, html: selectedInfo?.html || "", size: Number(snapSize.value || 34) });
        clearTextSelection();
        hideSelectionTools();
        return;
      }
      snapText.textContent = text;
      snapOverlay.style.setProperty("--snap-size", snapSize.value + "px");
      snapOverlay.style.setProperty("--snap-border", randomSnapColor());
      snapOverlay.style.display = "flex";
      clearTextSelection();
      hideSelectionTools();
    }

    function randomSnapColor() {
      const colors = ["#70e6ff", "#ffffff", "#f9e85d", "#ff64c8", "#8b5cf6", "#22c55e"];
      return colors[Math.floor(Math.random() * colors.length)];
    }

    function closeSnap() {
      snapOverlay.style.display = "none";
      snapText.textContent = "";
    }

    function selectionInfo(selection, box) {
      const html = selectionHtml(selection);
      const text = selectionText(selection);
      const markdown = htmlToMarkdown(html) || text;
      let vault = chatSaveVault.value || "";
      let path = "wiki/questions/agent-ui-notes.md";
      const ref = closestSourceRef(selection.anchorNode, box);
      if (ref) {
        const [refVault, ...rest] = ref.textContent.split("/");
        vault = refVault.trim();
        path = rest.join("/").trim();
      }
      return { text, html, markdown, vault, path, occurrence: selectionOccurrence(selection, box, text) };
    }

    function selectionOccurrence(selection, box, selectedText) {
      if (!selection.rangeCount || !selectedText) return 0;
      const range = selection.getRangeAt(0);
      const before = document.createRange();
      before.selectNodeContents(box);
      before.setEnd(range.startContainer, range.startOffset);
      const prefix = before.toString().toLowerCase();
      const needle = selectedText.toLowerCase();
      let count = 0;
      let index = prefix.indexOf(needle);
      while (index !== -1) {
        count += 1;
        index = prefix.indexOf(needle, index + needle.length);
      }
      return count;
    }

    function closestSourceRef(node, box) {
      let element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      while (element && element !== box) {
        let previous = element.previousElementSibling;
        while (previous) {
          if (previous.classList?.contains("source-ref")) return previous;
          previous = previous.previousElementSibling;
        }
        element = element.parentElement;
      }
      return box.querySelector(".source-ref");
    }

    async function saveSelectedNote() {
      if (!selectedInfo || !noteText.value.trim()) return;
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...selectedInfo, selectedText: selectedInfo.text, note: noteText.value.trim() })
      });
      const data = await response.json();
      if (data.error) {
        noteText.value = data.error;
        return;
      }
      noteEditor.style.display = "none";
      clearTextSelection();
      hideSelectionTools();
      notesCache = [data.note, ...notesCache.filter((note) => note.id !== data.note.id)];
      refreshResultAnnotations();
      renderNotesList();
    }

    function insertNoteLink() {
      const url = noteLinkUrl.value.trim();
      if (!url) {
        noteMediaFeedback.textContent = "Add a URL first";
        setTimeout(() => { noteMediaFeedback.textContent = ""; }, 1800);
        return;
      }
      const label = noteLinkText.value.trim() || url;
      insertAtCursor(noteText, "[" + label.replace(/\\]/g, "\\\\]") + "](" + url.replace(/\\)/g, "%29") + ")");
      noteLinkText.value = "";
      noteLinkUrl.value = "";
      noteText.focus();
    }

    async function uploadNoteMedia() {
      const file = noteMedia.files && noteMedia.files[0];
      if (!file || !selectedInfo) return;
      await uploadNoteMediaFile(file);
      noteMedia.value = "";
    }

    async function pasteNoteMedia(event) {
      const files = Array.from(event.clipboardData?.files || []);
      const itemFiles = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter(Boolean);
      const file = [...files, ...itemFiles].find((item) =>
        /^(image|audio|video)\\//.test(item.type) || item.type === "application/pdf"
      );
      if (!file) return;
      event.preventDefault();
      const ext = extensionFromMime(file.type);
      const name = file.name && file.name !== "image.png" ? file.name : "clipboard-media" + ext;
      const namedFile = file.name === name ? file : new File([file], name, { type: file.type || "application/octet-stream" });
      await uploadNoteMediaFile(namedFile, "Pasted media added");
    }

    async function uploadNoteMediaFile(file, successMessage = "Media added") {
      if (!file || !selectedInfo) return;
      noteMediaFeedback.textContent = "Adding media...";
      noteMedia.disabled = true;
      try {
        const data = await readFileAsDataURL(file);
        const response = await fetch("/api/notes/media", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vault: selectedInfo.vault,
            path: selectedInfo.path,
            filename: file.name,
            data
          })
        });
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        insertAtCursor(noteText, (noteText.value.trim() ? "\\n" : "") + result.markdown + "\\n");
        noteMediaFeedback.textContent = successMessage;
        noteText.focus();
      } catch (error) {
        noteMediaFeedback.textContent = error.message;
      } finally {
        noteMedia.disabled = false;
        setTimeout(() => { noteMediaFeedback.textContent = ""; }, 2400);
      }
    }

    function extensionFromMime(type) {
      const map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
        "application/pdf": ".pdf",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/mp4": ".m4a",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov"
      };
      return map[type] || ".bin";
    }

    function insertAtCursor(textarea, value) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + value + textarea.value.slice(end);
      const next = start + value.length;
      textarea.selectionStart = next;
      textarea.selectionEnd = next;
    }

    function readFileAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Could not read media file."));
        reader.readAsDataURL(file);
      });
    }

    async function loadNotes(options = {}) {
      const annotateResults = options.annotateResults !== false;
      notesList.textContent = "Loading...";
      try {
        const response = await fetch("/api/notes");
        const data = await response.json();
        const notes = data.notes || [];
        notesCache = notes;
        if (annotateResults) refreshResultAnnotations();
        renderNotesList();
      } catch (error) {
        notesList.textContent = error.message;
      }
    }

    function renderNotesList() {
      if (!notesCache.length) {
        notesList.innerHTML = '<p class="muted">No user notes yet.</p>';
        return;
      }
      notesList.innerHTML = notesCache.map((note) => '<div class="note-card" data-id="' + escapeHtml(note.id) + '">' +
        '<div class="source-ref">' + escapeHtml(note.vault + " / " + note.path) + '</div>' +
        '<p><strong>Selected:</strong> ' + escapeHtml(note.selectedText) + '</p>' +
        '<textarea class="note-edit">' + escapeHtml(note.note) + '</textarea>' +
        '<div class="note-row-actions">' +
          '<button class="secondary note-toggle" type="button">Hide</button>' +
          '<button class="secondary note-save-edit" type="button">Save</button>' +
          '<button class="secondary note-delete" type="button">Delete</button>' +
          '<span class="copy-feedback note-edit-feedback"></span>' +
        '</div>' +
      '</div>').join("");
      notesList.querySelectorAll(".note-card").forEach((card) => wireNoteCard(card));
    }

    function wireNoteCard(card) {
      const id = card.dataset.id;
      const textarea = card.querySelector(".note-edit");
      card.querySelector(".note-toggle").addEventListener("click", (event) => {
        const hidden = textarea.style.display === "none";
        textarea.style.display = hidden ? "" : "none";
        event.target.textContent = hidden ? "Hide" : "Show";
      });
      card.querySelector(".note-save-edit").addEventListener("click", async () => {
        const feedback = card.querySelector(".note-edit-feedback");
        const response = await fetch("/api/notes/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, note: textarea.value })
        });
        if (!response.ok) {
          feedback.textContent = "Save failed";
          setTimeout(() => { feedback.textContent = ""; }, 2000);
          return;
        }
        feedback.textContent = "Saved";
        setTimeout(() => { loadNotes(); }, 600);
      });
      card.querySelector(".note-delete").addEventListener("click", async () => {
        await fetch("/api/notes/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id })
        });
        loadNotes();
      });
    }

    function refreshResultAnnotations() {
      if (lastChatMarkdown) {
        answer.innerHTML = renderMarkdown(lastChatMarkdown);
        applyNoteAnnotations(answer);
      }
      if (lastLocalMarkdown) {
        renderLocalResultBox();
      }
    }

    function applyNoteAnnotations(container) {
      for (const note of notesCache) {
        if (!note.selectedText || note.selectedText.length < 3) continue;
        annotateNoteOccurrence(container, note);
      }
    }

    function annotateNoteOccurrence(container, note) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest(".note-anchor") || parent.closest(".note-indicator") || parent.closest(".source-ref")) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.nodeValue.toLowerCase().includes(note.selectedText.toLowerCase())
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });
      const targetOccurrence = Number(note.occurrence || 0);
      let seen = 0;
      let node = walker.nextNode();
      let index = -1;
      while (node) {
        const lower = node.nodeValue.toLowerCase();
        let searchFrom = 0;
        while (true) {
          index = lower.indexOf(note.selectedText.toLowerCase(), searchFrom);
          if (index < 0) break;
          if (seen === targetOccurrence) {
            insertNoteIndicator(node, index, note);
            return;
          }
          seen += 1;
          searchFrom = index + note.selectedText.length;
        }
        node = walker.nextNode();
      }
    }

    function insertNoteIndicator(node, index, note) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + note.selectedText.length);
      const anchor = document.createElement("span");
      anchor.className = "note-anchor";
      anchor.dataset.noteId = note.id;
      if (document.body.dataset.noteDisplay === "tooltip") anchor.title = note.note;
      try {
        range.surroundContents(anchor);
      } catch {
        anchor.textContent = range.toString();
        range.deleteContents();
        range.insertNode(anchor);
      }
      const indicator = document.createElement("span");
      indicator.className = "note-indicator";
      if (noteHasMedia(note.note)) indicator.classList.add("has-media");
      indicator.dataset.noteId = note.id;
      indicator.setAttribute("role", "button");
      indicator.setAttribute("aria-label", "User note");
      indicator.tabIndex = 0;
      if (document.body.dataset.noteDisplay === "tooltip" && !noteHasMedia(note.note)) indicator.title = note.note;
      indicator.addEventListener("mouseenter", () => maybeShowNotePopover(note, indicator));
      indicator.addEventListener("mouseleave", scheduleHideNotePopover);
      indicator.addEventListener("focus", () => maybeShowNotePopover(note, indicator));
      indicator.addEventListener("blur", scheduleHideNotePopover);
      indicator.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        showNoteCard(note.id);
      });
      indicator.addEventListener("click", (event) => {
        event.stopPropagation();
        showNoteCard(note.id);
      });
      anchor.after(indicator);
    }

    notePopover.addEventListener("mouseenter", () => {
      if (notePopoverTimer) clearTimeout(notePopoverTimer);
    });
    notePopover.addEventListener("mouseleave", scheduleHideNotePopover);
    notePopover.addEventListener("click", (event) => event.stopPropagation());

    function maybeShowNotePopover(note, indicator) {
      const useBrowserTooltip = document.body.dataset.noteDisplay === "tooltip" && !noteHasMedia(note.note);
      if (useBrowserTooltip) return;
      showNotePopover(note, indicator);
    }

    function showNotePopover(note, indicator) {
      if (notePopoverTimer) clearTimeout(notePopoverTimer);
      notePopover.innerHTML = renderNotePopover(note);
      notePopover.classList.add("visible");
      notePopover.style.left = "0px";
      notePopover.style.top = "0px";
      const indicatorRect = indicator.getBoundingClientRect();
      const popoverRect = notePopover.getBoundingClientRect();
      const margin = 12;
      let left = indicatorRect.left;
      let top = indicatorRect.bottom + 8;
      if (left + popoverRect.width > window.innerWidth - margin) {
        left = window.innerWidth - popoverRect.width - margin;
      }
      if (top + popoverRect.height > window.innerHeight - margin) {
        top = indicatorRect.top - popoverRect.height - 8;
      }
      notePopover.style.left = Math.max(margin, left) + "px";
      notePopover.style.top = Math.max(margin, top) + "px";
    }

    function scheduleHideNotePopover() {
      if (notePopoverTimer) clearTimeout(notePopoverTimer);
      notePopoverTimer = setTimeout(hideNotePopover, 160);
    }

    function hideNotePopover() {
      notePopover.classList.remove("visible");
      notePopover.innerHTML = "";
    }

    function noteHasMedia(note) {
      return /!\\[\\[[^\\]]+\\]\\]/.test(String(note || "")) ||
        /\\[[^\\]]+\\]\\((raw\\/assets\\/user-notes\\/[^)]+)\\)/.test(String(note || ""));
    }

    function renderNotePopover(note) {
      const vault = note.vault || "";
      return String(note.note || "")
        .split(/\\r?\\n/)
        .map((line) => renderNoteLine(line, vault))
        .join("");
    }

    function renderNoteLine(line, vault) {
      const text = String(line || "");
      if (!text.trim()) return "";
      const embedOnly = text.trim().match(/^!\\[\\[([^\\]]+)\\]\\]$/);
      if (embedOnly) return renderVaultEmbed(vault, embedOnly[1]);
      return "<p>" + inlineNoteMarkdown(text, vault) + "</p>";
    }

    function inlineNoteMarkdown(value, vault) {
      return escapeHtml(value)
        .replace(/!\\[\\[([^\\]]+)\\]\\]/g, (_match, file) => renderVaultEmbed(vault, decodeHtml(file)))
        .replace(/\\[\\[([^|\\]]+)\\|([^\\]]+)\\]\\]/g, "$2")
        .replace(/\\[\\[([^\\]]+)\\]\\]/g, "$1")
        .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
        .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
        .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (_match, label, href) => renderNoteLink(label, href, vault));
    }

    function renderNoteLink(label, href, vault) {
      const cleanHref = decodeHtml(href).trim();
      if (isLocalMediaPath(cleanHref)) return renderVaultEmbed(vault, cleanHref);
      return '<a href="' + escapeHtml(cleanHref) + '" target="_blank" rel="noreferrer">' + label + '</a>';
    }

    function isLocalMediaPath(value) {
      return /^raw\\/assets\\/user-notes\\//.test(String(value || ""));
    }

    function renderVaultEmbed(vault, file) {
      const clean = String(file || "").split("|")[0].trim();
      const src = "/api/vault-media?vault=" + encodeURIComponent(vault) + "&file=" + encodeURIComponent(clean);
      const ext = clean.split(".").pop().toLowerCase();
      if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
        return '<img src="' + src + '" alt="' + escapeHtml(clean) + '">';
      }
      if (["mp3", "wav", "m4a", "aiff"].includes(ext)) {
        return '<audio controls src="' + src + '"></audio>';
      }
      if (["mp4", "mov", "m4v"].includes(ext)) {
        return '<video controls src="' + src + '"></video>';
      }
      if (ext === "pdf") {
        return '<iframe src="' + src + '" title="' + escapeHtml(clean) + '"></iframe>';
      }
      return '<a href="' + src + '" target="_blank" rel="noreferrer">' + escapeHtml(clean) + '</a>';
    }

    function decodeHtml(value) {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = value;
      return textarea.value;
    }

    function showNoteCard(id) {
      activateTab("notes");
      renderNotesList();
      const card = notesList.querySelector('[data-id="' + cssEscape(id) + '"]');
      if (!card) return;
      const textarea = card.querySelector(".note-edit");
      const toggle = card.querySelector(".note-toggle");
      if (textarea && textarea.style.display === "none") {
        textarea.style.display = "";
        if (toggle) toggle.textContent = "Hide";
      }
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("focused");
      void card.offsetWidth;
      card.classList.add("focused");
      setTimeout(() => card.classList.remove("focused"), 1500);
    }

    function cssEscape(value) {
      if (window.CSS?.escape) return CSS.escape(value);
      return String(value).replace(/["\\\\]/g, "\\\\$&");
    }

    async function copyResult(container, markdown, format, feedback) {
      if (format === "html") await copyHtml(container.innerHTML, container.innerText);
      else if (format === "markdown") await navigator.clipboard.writeText(markdown || htmlToMarkdown(container.innerHTML));
      else await navigator.clipboard.writeText(container.innerText);
      showCopied(feedback);
    }

    async function copySelected(format) {
      if (!selectedInfo) return;
      if (format === "html") await copyHtml(selectedInfo.html, selectedInfo.text);
      else if (format === "markdown") await navigator.clipboard.writeText(selectedInfo.markdown);
      else await navigator.clipboard.writeText(selectedInfo.text);
      hideSelectionTools();
    }

    async function copyHtml(html, text) {
      if (window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" })
          })
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    }

    function showCopied(element) {
      element.textContent = "Copied";
      setTimeout(() => { element.textContent = ""; }, 1400);
    }

    function selectionClone(selection) {
      const div = document.createElement("div");
      for (let i = 0; i < selection.rangeCount; i++) {
        div.appendChild(selection.getRangeAt(i).cloneContents());
      }
      stripSelectionArtifacts(div);
      return div;
    }

    function stripSelectionArtifacts(container) {
      container.querySelectorAll(".note-indicator,.note-popover").forEach((node) => node.remove());
    }

    function selectionHtml(selection) {
      const div = selectionClone(selection);
      return div.innerHTML;
    }

    function selectionText(selection) {
      return selection.toString().replace(/\s+/g, " ").trim();
    }

    function htmlToMarkdown(html) {
      const div = document.createElement("div");
      div.innerHTML = html;
      div.querySelectorAll("h1,h2,h3").forEach((node) => {
        node.replaceWith("\\n## " + node.textContent + "\\n");
      });
      div.querySelectorAll("li").forEach((node) => {
        node.replaceWith("\\n- " + node.textContent);
      });
      div.querySelectorAll("p").forEach((node) => {
        node.replaceWith("\\n" + node.textContent + "\\n");
      });
      return div.textContent.replace(/\\n{3,}/g, "\\n\\n").trim();
    }

    function hideSelectionTools() {
      selectionToolbar.style.display = "none";
      noteEditor.style.display = "none";
      selectedInfo = null;
    }

    function clearChatResult() {
      input.value = "";
      answer.textContent = "Ready.";
      lastChatMarkdown = "";
      chatCopyFeedback.textContent = "";
      clearTextSelection();
      hideSelectionTools();
    }

    function clearLocalResult() {
      localInput.value = "";
      localAnswer.textContent = "Ready for local search.";
      lastLocalMarkdown = "";
      localCopyFeedback.textContent = "";
      clearTextSelection();
      hideSelectionTools();
    }

    function clearTextSelection() {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    }

    function closestHighlight(node) {
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return element?.closest?.("mark.agent-highlight");
    }

    function selectedHighlight(range) {
      const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      const direct = closestHighlight(range.startContainer) || closestHighlight(range.endContainer);
      if (direct && range.intersectsNode(direct)) return direct;
      return Array.from(root.querySelectorAll?.("mark.agent-highlight") || []).find((node) => range.intersectsNode(node)) || null;
    }

    function unwrapHighlight(element) {
      if (!element?.matches?.("mark.agent-highlight")) return;
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      parent.removeChild(element);
      parent.normalize();
    }

    function selectedNoteIndicators(range) {
      const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      return Array.from(root.querySelectorAll?.(".note-indicator") || []).filter((node) => range.intersectsNode(node));
    }

    loadSideTopics();
    loadStatus();
    loadProviderStatus();
    loadNotes();
    setInterval(loadSideTopics, 10000);
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>`;
}

function renderHelp() {
  const markdown = readHelpMarkdown();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Wiki Agent Help</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --soft: #eef2f7; --muted: #697386; --accent: #1f5eff; --accent-text: #ffffff; --shadow: rgba(20, 32, 50, 0.08); --code-bg: #edf2f7; --pre-bg: #f8fafc; }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --soft: #273449; --muted: #9ca3af; --accent: #60a5fa; --accent-text: #07111f; --shadow: rgba(0, 0, 0, 0.28); --code-bg: #111827; --pre-bg: #0f172a; }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --soft: #eadfca; --muted: #75664f; --accent: #8a5a19; --accent-text: #ffffff; --shadow: rgba(80, 58, 28, 0.12); --code-bg: #eadfca; --pre-bg: #fff5df; }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --soft: #dcebe1; --muted: #55705f; --accent: #22734a; --accent-text: #ffffff; --shadow: rgba(24, 82, 53, 0.12); --code-bg: #dcebe1; --pre-bg: #f5fbf7; }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --soft: #eeeeee; --muted: #333333; --accent: #000000; --accent-text: #ffffff; --shadow: rgba(0, 0, 0, 0.2); --code-bg: #eeeeee; --pre-bg: #ffffff; }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --soft: #222838; --muted: #9aa8bd; --accent: #39d5ff; --accent-text: #061019; --shadow: rgba(0, 0, 0, 0.36); --code-bg: #222838; --pre-bg: #0f131d; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 900px; margin: 0 auto; padding: 32px 20px 56px; }
    article { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 24px; line-height: 1.55; box-shadow: 0 12px 30px var(--shadow); }
    a { color: var(--accent); }
    code { background: var(--code-bg); color: var(--text); padding: 2px 5px; border-radius: 4px; }
    pre { background: var(--pre-bg); color: var(--text); border: 1px solid var(--line); padding: 14px; border-radius: 6px; overflow: auto; }
    pre code { background: transparent; color: inherit; padding: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--line); padding: 8px; text-align: left; }
    .back { display: inline-block; margin-bottom: 14px; font-weight: 650; text-decoration: none; }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <a class="back" href="/">Back to agent</a>
    <article>${markdownToHtml(markdown)}</article>
  </main>
  <script>
    document.body.dataset.theme = localStorage.getItem("llm-wiki-theme") || "light";
  </script>
</body>
</html>`;
}

function renderHelpMedia(file, media) {
  const encodedFile = encodeURIComponent(file);
  const src = `/media/${file.split("/").map(encodeURIComponent).join("/")}`;
  const title = path.basename(media.file);
  const contentType = media.contentType;
  const isVideo = contentType.startsWith("video/");
  const isAudio = contentType.startsWith("audio/");
  const isImage = contentType.startsWith("image/");
  const mediaMarkup = isVideo
    ? `<video controls preload="metadata" src="${src}"></video>`
    : isAudio
      ? `<audio controls preload="metadata" src="${src}"></audio>`
      : isImage
        ? `<img src="${src}" alt="${serverEscapeHtml(title)}">`
        : `<p>This media type may not preview in the app. Use the direct media link below.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${serverEscapeHtml(title)} - LLM Wiki Agent Help</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --muted: #697386; --accent: #1f5eff; --shadow: rgba(20, 32, 50, 0.08); }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --muted: #9ca3af; --accent: #60a5fa; --shadow: rgba(0, 0, 0, 0.28); }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --muted: #75664f; --accent: #8a5a19; --shadow: rgba(80, 58, 28, 0.12); }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --muted: #55705f; --accent: #22734a; --shadow: rgba(24, 82, 53, 0.12); }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --muted: #333333; --accent: #000000; --shadow: rgba(0, 0, 0, 0.2); }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --muted: #9aa8bd; --accent: #39d5ff; --shadow: rgba(0, 0, 0, 0.36); }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 42px; }
    nav { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
    a { color: var(--accent); font-weight: 700; text-decoration: none; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px; box-shadow: 0 12px 30px var(--shadow); }
    h1 { margin: 0; font-size: 20px; word-break: break-word; }
    .viewer { display: grid; place-items: center; min-height: 540px; background: #111; border-radius: 6px; overflow: hidden; }
    video, img { width: 100%; max-height: calc(100vh - 190px); object-fit: contain; background: #111; }
    audio { width: min(720px, 100%); }
    .meta { color: var(--muted); margin: 12px 0 0; }
    .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  </style>
</head>
<body>
  <main>
    <nav>
      <div class="actions">
        <a href="${src}" target="_blank" rel="noopener">Open raw media</a>
      </div>
      <h1>${serverEscapeHtml(title)}</h1>
    </nav>
    <section class="panel">
      <div class="viewer">${mediaMarkup}</div>
      <p class="meta">If the preview does not play, use Open raw media. The app serves this file with byte-range support for WebKit playback.</p>
    </section>
  </main>
  <script>
    document.body.dataset.theme = localStorage.getItem("llm-wiki-theme") || "light";
  </script>
</body>
</html>`;
}

function renderNotFound(message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Wiki Agent</title>
  <style>
    :root { --bg: #f6f7f9; --text: #18202b; --panel: #ffffff; --line: #dce1e8; --muted: #697386; --accent: #1f5eff; --shadow: rgba(20, 32, 50, 0.08); }
    body[data-theme="dark"] { --bg: #111827; --text: #e5e7eb; --panel: #1f2937; --line: #374151; --muted: #9ca3af; --accent: #60a5fa; --shadow: rgba(0, 0, 0, 0.28); }
    body[data-theme="sepia"] { --bg: #f4ecd8; --text: #2f271f; --panel: #fffaf0; --line: #d8c7a3; --muted: #75664f; --accent: #8a5a19; --shadow: rgba(80, 58, 28, 0.12); }
    body[data-theme="forest"] { --bg: #edf5ef; --text: #10251a; --panel: #fbfffc; --line: #b8d0c0; --muted: #55705f; --accent: #22734a; --shadow: rgba(24, 82, 53, 0.12); }
    body[data-theme="contrast"] { --bg: #ffffff; --text: #000000; --panel: #ffffff; --line: #000000; --muted: #333333; --accent: #000000; --shadow: rgba(0, 0, 0, 0.2); }
    body[data-theme="megatron"] { --bg: #0b0d12; --text: #e8eef7; --panel: #161a23; --line: #3b4354; --muted: #9aa8bd; --accent: #39d5ff; --shadow: rgba(0, 0, 0, 0.36); }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 720px; margin: 0 auto; padding: 72px 20px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 24px; box-shadow: 0 12px 30px var(--shadow); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { color: var(--muted); line-height: 1.5; }
    a { color: var(--accent); font-weight: 700; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Content not found</h1>
      <p>${serverEscapeHtml(message)}</p>
      <a href="/help">Back to README</a>
    </section>
  </main>
  <script>
    document.body.dataset.theme = localStorage.getItem("llm-wiki-theme") || "light";
  </script>
</body>
</html>`;
}

function readHelpMarkdown() {
  const candidates = [
    path.join(agentRoot, "README.md"),
    path.resolve("README.md"),
    path.resolve("../README.md"),
    path.join(agentRoot, "docs", "ENV_AND_GITIGNORE.md"),
    path.resolve("docs/ENV_AND_GITIGNORE.md")
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    } catch {
      // Try the next bundled help source.
    }
  }
  return [
    "# LLM Wiki Agent Help",
    "",
    "The app help file could not be found in this installation.",
    "",
    "Use the menu bar icon to open the config file, verify `VAULTS_ROOT`, and reinstall the app from the latest build."
  ].join("\\n");
}

function markdownToHtml(markdown) {
  const lines = sanitizeHelpMarkdown(markdown).split(/\r?\n/);
  const html = [];
  let inCode = false;
  let inList = false;
  const usedHeadingIds = new Map();
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push("</code></pre>");
      } else {
        html.push("<pre><code>");
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(serverEscapeHtml(line));
      continue;
    }
    if (/^\s*<a\s+id=["']top["']><\/a>\s*$/i.test(line)) {
      closeList();
      html.push('<a id="top"></a>');
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      html.push(headingHtml(1, line.slice(2), usedHeadingIds));
    }
    else if (line.startsWith("## ")) {
      closeList();
      html.push(headingHtml(2, line.slice(3), usedHeadingIds));
    }
    else if (line.startsWith("### ")) {
      closeList();
      html.push(headingHtml(3, line.slice(4), usedHeadingIds));
    }
    else if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      closeList();
      if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join("\n");
}

function sanitizeHelpMarkdown(markdown) {
  return String(markdown)
    .replace(/<p\s+align=["']center["']>[\s\S]*?<\/p>\s*/gi, "")
    .replace(/^\s*<img\b[^>]*>\s*$/gmi, "")
    .replace(/^\s*<\/?p[^>]*>\s*$/gmi, "");
}

function headingHtml(level, text, usedHeadingIds) {
  const id = uniqueHeadingId(helpHeadingSlug(text), usedHeadingIds);
  return `<h${level} id="${serverEscapeHtml(id)}">${inline(text)}</h${level}>`;
}

function uniqueHeadingId(base, usedHeadingIds) {
  const clean = base || "section";
  const count = usedHeadingIds.get(clean) || 0;
  usedHeadingIds.set(clean, count + 1);
  return count ? `${clean}-${count}` : clean;
}

function helpHeadingSlug(text) {
  return decodeHtmlEntities(String(text || ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inline(text) {
  return serverEscapeHtml(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, href) => `<span class="muted">${alt}</span>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => renderHelpLink(label, href))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderHelpLink(label, href) {
  const mediaHref = decodeHtmlEntities(href);
  if (isHelpMediaLink(mediaHref)) {
    return `<a href="/help-media?file=${encodeURIComponent(mediaHref.replace(/^media\//, ""))}" target="_blank" rel="noopener">${label}</a>`;
  }
  if (mediaHref.startsWith("#")) {
    return `<a href="${href}">${label}</a>`;
  }
  if (mediaHref.startsWith("/") || mediaHref.startsWith("http://") || mediaHref.startsWith("https://")) {
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  }
  return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
}

function isHelpMediaLink(href) {
  const normalized = String(href || "").toLowerCase();
  return normalized.startsWith("media/") && /\.(png|jpe?g|gif|webp|svg|mp3|wav|m4a|aiff|mp4|mov|m4v|pdf)$/.test(normalized);
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function serverEscapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatLocal(date) {
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + (zone ? ` ${zone}` : "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}
