import { getConfig } from "./config.mjs";
import { listArchiveHistory, listFileHistory } from "./history.mjs";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";
import path from "node:path";

const config = getConfig();
const requested = new Set((process.argv[2] || "all").split(",").map((item) => item.trim()).filter(Boolean));
const includeAll = requested.has("all");

try {
  const result = {};
  if (includeAll || requested.has("files")) result.files = listFileHistory(config);
  if (includeAll || requested.has("archives")) result.archives = listArchiveHistory(config);
  if (includeAll || requested.has("topics")) result.topics = listTopicsFromIndexes(config);
  if (includeAll || requested.has("notes")) result.notes = listDedicatedNotes(config);
  process.send?.({ ok: true, result });
} catch (error) {
  process.send?.({ ok: false, error: error.message });
  process.exitCode = 1;
}

function listTopicsFromIndexes(config) {
  const topics = new Map();
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
    for (const line of index.split(/\r?\n/)) {
      if (!line.startsWith("| [[")) continue;
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      const link = parseWikiLink(cells[0]);
      if (!link) continue;
      addTopic(topics, {
        vault,
        title: link.title,
        path: link.path,
        type: cells[1],
        summary: cells[2],
        updated: cells[3],
        tags: [],
        created: "",
        element: cells[1]
      });
    }
  }
  for (const record of listFileHistory(config)) {
    if (!record.sourcePage) continue;
    addTopic(topics, {
      vault: record.vault,
      title: titleFromPath(record.sourcePage),
      path: record.sourcePage.replace(/\.md$/i, ""),
      type: "source",
      summary: record.file || record.sourcePage,
      updated: dateFromLocal(record.processedAt) || dateFromLocal(record.receivedAt),
      tags: [],
      created: dateFromLocal(record.receivedAt),
      element: "source"
    });
  }
  return [...topics.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function addTopic(topics, topic) {
  const key = `${topic.vault}|${topic.path}`;
  if (!topics.has(key)) topics.set(key, topic);
}

function parseWikiLink(cell) {
  const match = cell.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  const pagePath = match[1];
  return {
    path: pagePath,
    title: match[2] || path.basename(pagePath).replace(/-/g, " ")
  };
}

function titleFromPath(value) {
  return path.basename(String(value || ""), path.extname(String(value || "")))
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function dateFromLocal(value) {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function listDedicatedNotes(config) {
  const notes = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const rel = "wiki/questions/agent-ui-notes.md";
    const text = readIfExists(path.join(vaultPath, rel));
    notes.push(...parseNotes(text, vaultName(vaultPath), rel));
  }
  return notes.sort((a, b) => b.updated.localeCompare(a.updated));
}

function parseNotes(text, vault, relativePath) {
  const notes = [];
  const regex = /<!-- agent-note:([^ ]+) -->([\s\S]*?)<!-- \/agent-note:\1 -->/g;
  let match;
  while ((match = regex.exec(text))) {
    const body = match[2];
    notes.push({
      id: match[1],
      vault,
      path: relativePath,
      selectedText: field(body, "Selected"),
      note: field(body, "Note"),
      occurrence: Number(field(body, "Occurrence") || 0),
      created: field(body, "Created"),
      updated: field(body, "Updated")
    });
  }
  return notes;
}

function field(body, label) {
  const match = body.match(new RegExp(`^> \\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n> \\*\\*|$)`, "m"));
  return match ? match[1].replace(/^> /gm, "").trim() : "";
}
