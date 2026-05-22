import http from "node:http";
import fs from "node:fs";
import { deleteArchivedItems } from "./archive-delete.mjs";
import { restoreArchivedItems } from "./archive-restore.mjs";
import { getConfig } from "./config.mjs";
import { answerQuestion } from "./chat-lib.mjs";
import { saveChatAsRawSource } from "./chat-source.mjs";
import { listArchiveHistory, listFileHistory } from "./history.mjs";
import { ingestVault } from "./ingest-lib.mjs";
import { answerLocally } from "./local-answer.mjs";
import { addNote, deleteNote, listNotes, updateNote } from "./notes.mjs";
import { createProvider } from "./provider.mjs";
import { providerStatus } from "./provider-status.mjs";
import { preflightStatus } from "./preflight.mjs";
import { deleteSources } from "./source-delete.mjs";
import { topicContent } from "./topic-content.mjs";
import { listTopics } from "./topics.mjs";
import { listVaults, vaultName } from "./vaults.mjs";
import { bootstrapVault } from "./vault-bootstrap.mjs";

const config = getConfig();
const provider = createProvider(config);
let ingestRunning = false;
let lastIngestMessage = "Auto-ingest has not run yet.";

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
    response.end(JSON.stringify({ ingestRunning, lastIngestMessage }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/provider-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(await providerStatus(config)));
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

  response.writeHead(404);
  response.end("Not found");
});

server.listen(config.chatPort, "127.0.0.1", () => {
  console.log(`LLM Wiki chat UI: http://127.0.0.1:${config.chatPort}`);
  startAutoIngest();
});

function startAutoIngest() {
  runAutoIngest();
  setInterval(runAutoIngest, config.watchIntervalMs);
}

async function runAutoIngest() {
  if (ingestRunning) return;
  ingestRunning = true;
  try {
    let count = 0;
    for (const vault of listVaults(config.vaultsRoot)) {
      const bootstrapped = bootstrapVault(vault);
      if (bootstrapped.length) {
        console.log(`[bootstrap] ${vaultName(vault)}: ${bootstrapped.join(", ")}`);
      }
      const results = await ingestVault(vault, config, provider);
      count += results.length;
      for (const result of results) {
        console.log(`[auto-ingest] ${result.vault}: ${result.source} -> ${result.sourcePage}`);
      }
    }
    lastIngestMessage = count
      ? `Processed ${count} file${count === 1 ? "" : "s"} at ${formatLocal(new Date())}.`
      : `No pending files at ${formatLocal(new Date())}.`;
  } catch (error) {
    lastIngestMessage = `Auto-ingest error at ${formatLocal(new Date())}: ${error.message}`;
    console.error(`[auto-ingest] ${error.stack || error.message}`);
  } finally {
    ingestRunning = false;
  }
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
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 920px; margin: 0 auto; padding: 32px 300px 32px 20px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    h1 { font-size: 24px; margin: 0; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    select { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); padding: 8px; }
    .help { color: var(--accent); text-decoration: none; font-weight: 650; }
    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
    .tab { appearance: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; color: var(--muted); padding: 10px 12px; cursor: pointer; }
    .tab .status-dot { width: 8px; height: 8px; margin-right: 6px; box-shadow: none; vertical-align: 1px; }
    .tab.active { border-bottom-color: var(--accent); color: var(--text); font-weight: 700; }
    .panel { display: none; }
    .panel.active { display: block; }
    form { display: flex; gap: 10px; margin-bottom: 18px; }
    input, textarea { flex: 1; font: inherit; padding: 12px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); }
    textarea { min-height: 90px; width: 100%; box-sizing: border-box; resize: vertical; }
    button.primary { font: inherit; padding: 12px 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-text); cursor: pointer; }
    button.secondary { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: default; }
    .result-tools { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; margin: -6px 0 10px; }
    .copy-feedback { color: var(--muted); font-size: 13px; min-width: 54px; }
    .answer { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px; min-height: 260px; line-height: 1.5; }
    .answer p { margin: 0 0 12px; }
    .answer ul, .answer ol { margin-top: 0; padding-left: 24px; }
    mark.agent-highlight { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 2px; }
    .note-anchor { color: inherit; }
    .note-indicator { display: inline-block; margin-left: 4px; border: 1px solid var(--line); border-radius: 999px; padding: 0 5px; font-size: 11px; color: var(--accent); background: var(--soft); vertical-align: super; cursor: default; }
    .note-indicator { position: relative; }
    body[data-note-display="tooltip"] .note-indicator { text-decoration: underline dotted; }
    body[data-note-display="box"] .note-indicator { cursor: help; }
    .note-indicator::after { content: attr(data-note); display: none; position: absolute; left: 0; top: 130%; z-index: 30; min-width: 220px; max-width: 320px; white-space: normal; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 12px 30px var(--shadow); padding: 10px; font-size: 13px; line-height: 1.35; }
    body[data-note-display="box"] .note-indicator:hover::after { display: block; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
    th { background: var(--soft); font-weight: 700; }
    tr:last-child td { border-bottom: 0; }
    .muted { color: var(--muted); }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
    .side-topics { position: fixed; top: 20px; right: 20px; width: 250px; max-height: calc(100vh - 40px); overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px; box-shadow: 0 12px 30px var(--shadow); }
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
    .note-editor { display: none; position: fixed; z-index: 21; width: 320px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 12px 30px var(--shadow); padding: 10px; }
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
        </select>
        <a class="help" href="/help" target="_blank" rel="noreferrer">Help</a>
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
      <div id="answer" class="answer">Ready.</div>
    </section>
    <section id="local-panel" class="panel">
      <form id="local-form">
        <input id="local-question" autocomplete="off" placeholder="Ask locally without AI or internet">
        <button id="local-ask" class="primary" type="submit">Search</button>
        <button id="clear-local" class="secondary" type="button">Clear</button>
      </form>
      <p class="muted">Local mode searches stored wiki markdown only. It does not call an AI provider and does not connect to the internet.</p>
      <div class="result-tools">
        <select id="local-copy-format">
          <option value="text">Pure text</option>
          <option value="html">Formatted text</option>
          <option value="markdown">Markdown</option>
        </select>
        <button id="copy-local" class="secondary" type="button">Copy</button>
        <span id="local-copy-feedback" class="copy-feedback"></span>
      </div>
      <div id="local-answer" class="answer">Ready for local search.</div>
    </section>
    <section id="files-panel" class="panel">
      <p class="muted">Received and processed files are shown in local time.</p>
      <div class="result-tools">
        <button id="delete-sources" class="secondary" type="button">Archive selected sources</button>
        <span id="delete-sources-feedback" class="copy-feedback"></span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th>#</th>
            <th>Vault</th>
            <th>File</th>
            <th>Received</th>
            <th>Processed</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="files-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="archives-panel" class="panel">
      <p class="muted">Archived raw sources and archived wiki pages. These are removed from active wiki navigation but preserved on disk.</p>
      <div class="result-tools">
        <button id="restore-archives" class="secondary" type="button">Restore selected archived items</button>
        <button id="delete-archives" class="secondary" type="button">Delete selected archived items</button>
        <span id="restore-archives-feedback" class="copy-feedback"></span>
        <span id="delete-archives-feedback" class="copy-feedback"></span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th>#</th>
            <th>Vault</th>
            <th>Type</th>
            <th>Relation</th>
            <th>Path</th>
            <th>Archived</th>
          </tr>
        </thead>
        <tbody id="archives-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="topics-panel" class="panel">
      <p class="muted">All available wiki topics and insights with their vault paths.</p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Topic</th>
            <th>Type</th>
            <th>Vault</th>
            <th>Path</th>
            <th>Tags</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody id="topics-body">
          <tr><td colspan="7" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
    <section id="provider-panel" class="panel">
      <p class="muted">Current AI provider configuration. Secret values are hidden.</p>
      <button id="refresh-provider" class="secondary" type="button">Refresh</button>
      <div id="provider-status-box" class="answer">Loading provider status...</div>
    </section>
    <section id="notes-panel" class="panel">
      <p class="muted">User notes added from highlighted answer text. Notes are also written into markdown files for Obsidian.</p>
      <div class="result-tools">
        <label class="muted" for="note-display-mode">Hover note display</label>
        <select id="note-display-mode">
          <option value="box">Note box</option>
          <option value="tooltip">Browser tooltip</option>
        </select>
      </div>
      <button id="refresh-notes" class="secondary" type="button">Refresh</button>
      <div id="notes-list" class="notes-list">Loading...</div>
    </section>
  </main>
  <aside class="side-topics">
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
    <div id="topic-list" class="muted">Loading...</div>
  </aside>
  <div id="selection-toolbar" class="selection-toolbar">
    <button id="sel-highlight" class="secondary" type="button">Highlight</button>
    <button id="sel-copy-text" class="secondary" type="button">Copy text</button>
    <button id="sel-copy-html" class="secondary" type="button">Copy formatted</button>
    <button id="sel-copy-md" class="secondary" type="button">Copy MD</button>
    <button id="sel-note" class="secondary" type="button">Add note</button>
  </div>
  <div id="note-editor" class="note-editor">
    <div class="muted">Note for selected text</div>
    <textarea id="note-text" placeholder="Write a note"></textarea>
    <div class="note-actions">
      <button id="note-cancel" class="secondary" type="button">Cancel</button>
      <button id="note-save" class="primary" type="button">Save</button>
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
    const tabs = document.querySelectorAll(".tab");
    const filesBody = document.querySelector("#files-body");
    const archivesBody = document.querySelector("#archives-body");
    const deleteSourcesButton = document.querySelector("#delete-sources");
    const deleteSourcesFeedback = document.querySelector("#delete-sources-feedback");
    const deleteArchivesButton = document.querySelector("#delete-archives");
    const deleteArchivesFeedback = document.querySelector("#delete-archives-feedback");
    const restoreArchivesButton = document.querySelector("#restore-archives");
    const restoreArchivesFeedback = document.querySelector("#restore-archives-feedback");
    const topicsBody = document.querySelector("#topics-body");
    const providerStatusBox = document.querySelector("#provider-status-box");
    const refreshProvider = document.querySelector("#refresh-provider");
    const providerTabDot = document.querySelector("#provider-tab-dot");
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
    const noteText = document.querySelector("#note-text");
    const notesList = document.querySelector("#notes-list");
    const refreshNotes = document.querySelector("#refresh-notes");
    const noteDisplayMode = document.querySelector("#note-display-mode");
    let lastChatMarkdown = "";
    let lastLocalMarkdown = "";
    let selectedInfo = null;
    let notesCache = [];
    let sideTopicsCache = [];

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
      refreshResultAnnotations();
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
        localAnswer.innerHTML = renderMarkdown(lastLocalMarkdown);
        applyNoteAnnotations(localAnswer);
      } catch (error) {
        localAnswer.textContent = error.message;
      } finally {
        localButton.disabled = false;
      }
    });

    copyChat.addEventListener("click", () => copyResult(answer, lastChatMarkdown, chatCopyFormat.value, chatCopyFeedback));
    saveChatSource.addEventListener("click", saveChatAsSource);
    copyLocal.addEventListener("click", () => copyResult(localAnswer, lastLocalMarkdown, localCopyFormat.value, localCopyFeedback));
    clearChat.addEventListener("click", () => clearChatResult());
    clearLocal.addEventListener("click", () => clearLocalResult());
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
    refreshNotes.addEventListener("click", loadNotes);

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
        if (!data.files || !data.files.length) {
          filesBody.innerHTML = '<tr><td colspan="7" class="muted">No processed files yet.</td></tr>';
          return;
        }
        filesBody.innerHTML = data.files.map((file) => '<tr>' +
          '<td><input class="source-select" type="checkbox" data-vault="' + escapeHtml(file.vault) + '" data-file="' + escapeHtml(file.file) + '" data-source-page="' + escapeHtml(file.sourcePage || "") + '"></td>' +
          '<td>' + escapeHtml(file.number) + '</td>' +
          '<td>' + escapeHtml(file.vault) + '</td>' +
          '<td><div class="path">' + escapeHtml(file.file) + '</div><div class="muted path">' + escapeHtml(file.sourcePage || "") + '</div></td>' +
          '<td>' + escapeHtml(file.receivedAt) + '</td>' +
          '<td>' + escapeHtml(file.processedAt) + '</td>' +
          '<td>' + escapeHtml(file.status) + '</td>' +
        '</tr>').join("");
      } catch (error) {
        filesBody.innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
      }
    }

    async function deleteSelectedSources() {
      const selected = Array.from(document.querySelectorAll(".source-select:checked")).map((item) => ({
        vault: item.dataset.vault,
        file: item.dataset.file,
        sourcePage: item.dataset.sourcePage
      }));
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

    async function loadArchives() {
      archivesBody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
      try {
        const response = await fetch("/api/archives");
        const data = await response.json();
        const archives = data.archives || [];
        if (!archives.length) {
          archivesBody.innerHTML = '<tr><td colspan="7" class="muted">No archived sources yet.</td></tr>';
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
      } catch (error) {
        archivesBody.innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
      }
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
        const topics = data.topics || [];
        if (!topics.length) {
          topicsBody.innerHTML = '<tr><td colspan="7" class="muted">No topics yet.</td></tr>';
          return;
        }
        topicsBody.innerHTML = topics.map((topic, index) => '<tr>' +
          '<td>' + (index + 1) + '</td>' +
          '<td>' + escapeHtml(topic.title) + '<div class="muted">' + escapeHtml(topic.summary || "") + '</div></td>' +
          '<td>' + escapeHtml(topic.type) + '</td>' +
          '<td>' + escapeHtml(topic.vault) + '</td>' +
          '<td class="path">' + escapeHtml(topic.path) + '</td>' +
          '<td>' + escapeHtml((topic.tags || []).join(", ")) + '</td>' +
          '<td>' + escapeHtml(topic.updated) + '</td>' +
        '</tr>').join("");
      } catch (error) {
        topicsBody.innerHTML = '<tr><td colspan="7">' + escapeHtml(error.message) + '</td></tr>';
      }
    }

    async function loadProviderStatus() {
      providerStatusBox.textContent = "Loading provider status...";
      try {
        const response = await fetch("/api/provider-status");
        const data = await response.json();
        updateProviderTabStatus(data.statusColor, data.status, data.statusDetail);
        const rows = [
          ["Provider", data.provider],
          ["Model", data.model],
          ["Access method", data.accessMethod],
          ["Auth method", data.authMethod],
          ["Credential", data.credentialConfigured ? "configured" : "not configured"],
          ["Status detail", data.statusDetail || ""]
        ];
        providerStatusBox.innerHTML = '<h2>Current Provider</h2>' +
          '<div class="provider-state"><span class="status-dot ' + escapeHtml(data.statusColor || "grey") + '"></span><span>' + escapeHtml(data.status || "Unknown") + '</span></div>' +
          '<table><tbody>' + rows.map(([label, value]) =>
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
          if (selectedType && topic.type !== selectedType) return false;
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
      const types = [...new Set(sideTopicsCache.map((topic) => topic.type).filter(Boolean))].sort();
      sideTopicType.innerHTML = '<option value="">All elements</option>' + types.map((type) =>
        '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + '</option>'
      ).join("");
      if (types.includes(current)) sideTopicType.value = current;
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
        localAnswer.innerHTML = renderMarkdown(lastLocalMarkdown);
        applyNoteAnnotations(localAnswer);
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
        statusEl.textContent = data.lastIngestMessage || "Auto-ingest is running.";
      } catch (error) {
        statusEl.textContent = error.message;
      }
    }

    function renderMarkdown(markdown) {
      const lines = String(markdown).split(/\\r?\\n/);
      const html = [];
      let inList = false;
      for (const line of lines) {
        if (/^\\s*[-*]\\s+/.test(line)) {
          if (!inList) {
            html.push("<ul>");
            inList = true;
          }
          html.push("<li>" + inlineMarkdown(line.replace(/^\\s*[-*]\\s+/, "")) + "</li>");
          continue;
        }
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        if (/^[A-Za-z0-9_-]+-vault\\s+\\/\\s+wiki\\/.+/.test(line)) html.push("<p class=\\"source-ref\\">" + inlineMarkdown(line) + "</p>");
        else if (/^###\\s+/.test(line)) html.push("<h3>" + inlineMarkdown(line.replace(/^###\\s+/, "")) + "</h3>");
        else if (/^##\\s+/.test(line)) html.push("<h2>" + inlineMarkdown(line.replace(/^##\\s+/, "")) + "</h2>");
        else if (/^#\\s+/.test(line)) html.push("<h1>" + inlineMarkdown(line.replace(/^#\\s+/, "")) + "</h1>");
        else if (line.trim()) html.push("<p>" + inlineMarkdown(line) + "</p>");
      }
      if (inList) html.push("</ul>");
      return html.join("");
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

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
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
      if (event.target.closest("#selection-toolbar") || event.target.closest("#note-editor")) return;
      hideSelectionTools();
    });

    document.querySelector("#sel-highlight").addEventListener("click", () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const existing = closestHighlight(selection.anchorNode);
      if (existing) {
        unwrap(existing);
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
        mark.textContent = selection.toString();
        range.deleteContents();
        range.insertNode(mark);
      }
      selection.removeAllRanges();
      hideSelectionTools();
    });
    document.querySelector("#sel-copy-text").addEventListener("click", () => copySelected("text"));
    document.querySelector("#sel-copy-html").addEventListener("click", () => copySelected("html"));
    document.querySelector("#sel-copy-md").addEventListener("click", () => copySelected("markdown"));
    document.querySelector("#sel-note").addEventListener("click", () => {
      if (!selectedInfo) return;
      const rect = selectionToolbar.getBoundingClientRect();
      noteEditor.style.left = Math.max(12, rect.left) + "px";
      noteEditor.style.top = Math.max(12, rect.bottom + 8) + "px";
      noteText.value = "";
      noteEditor.style.display = "block";
      noteText.focus();
    });
    document.querySelector("#note-cancel").addEventListener("click", () => {
      noteEditor.style.display = "none";
    });
    document.querySelector("#note-save").addEventListener("click", saveSelectedNote);

    function selectionInfo(selection, box) {
      const text = selection.toString().trim();
      const html = selectionHtml(selection);
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
        await fetch("/api/notes/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, note: textarea.value })
        });
        loadNotes();
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
        localAnswer.innerHTML = renderMarkdown(lastLocalMarkdown);
        applyNoteAnnotations(localAnswer);
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
      indicator.dataset.noteId = note.id;
      indicator.dataset.note = note.note;
      if (document.body.dataset.noteDisplay === "tooltip") indicator.title = note.note;
      indicator.textContent = "note";
      indicator.addEventListener("click", (event) => {
        event.stopPropagation();
        showNoteCard(note.id);
      });
      anchor.after(indicator);
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

    function selectionHtml(selection) {
      const div = document.createElement("div");
      for (let i = 0; i < selection.rangeCount; i++) {
        div.appendChild(selection.getRangeAt(i).cloneContents());
      }
      return div.innerHTML;
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

    function unwrap(element) {
      const parent = element.parentNode;
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
  const markdown = fs.readFileSync("README.md", "utf8");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Wiki Agent Help</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #18202b; }
    main { max-width: 900px; margin: 0 auto; padding: 32px 20px 56px; }
    article { background: white; border: 1px solid #dce1e8; border-radius: 6px; padding: 24px; line-height: 1.55; }
    a { color: #1f5eff; }
    code { background: #edf2f7; color: #172033; padding: 2px 5px; border-radius: 4px; }
    pre { background: #f8fafc; color: #172033; border: 1px solid #cbd5e1; padding: 14px; border-radius: 6px; overflow: auto; }
    pre code { background: transparent; color: inherit; padding: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #dce1e8; padding: 8px; text-align: left; }
  </style>
</head>
<body>
  <main>
    <p><a href="/">Back to agent</a></p>
    <article>${markdownToHtml(markdown)}</article>
  </main>
</body>
</html>`;
}

function markdownToHtml(markdown) {
  const escaped = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = escaped.split(/\r?\n/);
  const html = [];
  let inCode = false;
  let inList = false;
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
      html.push(line);
      continue;
    }
    if (line.startsWith("# ")) html.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("## ")) html.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("### ")) html.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

function inline(text) {
  return text.replace(/`([^`]+)`/g, "<code>$1</code>");
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
