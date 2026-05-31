import fs from "node:fs";
import path from "node:path";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function listTopics(config) {
  const topics = new Map();
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
    for (const topic of topicsFromIndex(vaultPath, vault, index)) {
      topics.set(topicKey(topic), topic);
    }
    for (const topic of topicsFromWikiFiles(vaultPath, vault)) {
      if (!topics.has(topicKey(topic))) topics.set(topicKey(topic), topic);
    }
  }
  return [...topics.values()]
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function listTopicsAsync(config) {
  const topics = new Map();
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
    for (const topic of topicsFromIndex(vaultPath, vault, index)) {
      topics.set(topicKey(topic), topic);
    }
    await yieldToEventLoop();
    for (const topic of await topicsFromWikiFilesAsync(vaultPath, vault)) {
      if (!topics.has(topicKey(topic))) topics.set(topicKey(topic), topic);
    }
    await yieldToEventLoop();
  }
  return [...topics.values()]
    .sort((a, b) => a.title.localeCompare(b.title));
}

function topicKey(topic) {
  return `${topic.vault}|${topic.path}`;
}

function topicsFromIndex(vaultPath, vault, index) {
  const topics = [];
  for (const line of index.split(/\r?\n/)) {
    if (!line.startsWith("| [[")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const link = parseWikiLink(cells[0]);
    if (!link) continue;
    const pageRel = link.path.endsWith(".md") ? link.path : `${link.path}.md`;
    const frontmatter = parseFrontmatter(readIfExists(path.join(vaultPath, pageRel)));
    topics.push({
      vault,
      title: link.title,
      path: link.path,
      type: cells[1],
      summary: cells[2],
      updated: cells[3],
      tags: frontmatter.tags,
      created: frontmatter.created,
      element: cells[1]
    });
  }
  return topics;
}

function topicsFromWikiFiles(vaultPath, vault) {
  const wikiDir = path.join(vaultPath, "wiki");
  if (!fs.existsSync(wikiDir)) return [];
  const files = [];
  walkMarkdown(wikiDir, files);
  return files.map((file) => topicFromWikiFile(vaultPath, vault, file)).filter(Boolean);
}

async function topicsFromWikiFilesAsync(vaultPath, vault) {
  const wikiDir = path.join(vaultPath, "wiki");
  if (!fs.existsSync(wikiDir)) return [];
  const files = [];
  walkMarkdown(wikiDir, files);
  const topics = [];
  for (const [index, file] of files.entries()) {
    const topic = topicFromWikiFile(vaultPath, vault, file);
    if (topic) topics.push(topic);
    if (index % 20 === 19) await yieldToEventLoop();
  }
  return topics;
}

function walkMarkdown(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
}

function topicFromWikiFile(vaultPath, vault, file) {
  const markdown = readIfExists(file);
  const frontmatter = parseFrontmatter(markdown);
  const relWithExt = path.relative(vaultPath, file).replace(/\\/g, "/");
  const rel = relWithExt.replace(/\.md$/i, "");
  return {
    vault,
    title: frontmatter.title || firstHeading(markdown) || titleFromPath(rel),
    path: rel,
    type: frontmatter.type || typeFromPath(rel),
    summary: summaryFromMarkdown(markdown),
    updated: frontmatter.updated || updatedFromStat(file),
    tags: frontmatter.tags,
    created: frontmatter.created,
    element: frontmatter.type || typeFromPath(rel)
  };
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { tags: [], created: "", updated: "", title: "", type: "" };
  const block = match[1];
  const tags = [];
  const inlineTags = block.match(/^tags:\s*\[([^\]]*)\]\s*$/m);
  if (inlineTags) {
    tags.push(...inlineTags[1].split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
  }
  const tagBlock = block.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (tagBlock) {
    tags.push(...tagBlock[1].split(/\r?\n/).map((line) => line.replace(/^\s+-\s+/, "").trim()).filter(Boolean));
  }
  const title = frontmatterValue(block, "title");
  const type = frontmatterValue(block, "type");
  const created = block.match(/^created:\s*(.+)$/m)?.[1]?.trim() || "";
  const updated = block.match(/^updated:\s*(.+)$/m)?.[1]?.trim() || "";
  return { tags: [...new Set(tags)], created, updated, title, type };
}

function frontmatterValue(block, key) {
  return block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
}

function parseWikiLink(cell) {
  const match = cell.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  const pagePath = match[1];
  const alias = match[2];
  return {
    path: pagePath,
    title: alias || titleFromPath(pagePath)
  };
}

function titleFromPath(pagePath) {
  return path.basename(pagePath)
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function typeFromPath(pagePath) {
  const parts = String(pagePath || "").split("/");
  return parts[0] === "wiki" && parts[1] ? singularize(parts[1]) : "page";
}

function singularize(value) {
  const text = String(value || "");
  return text.endsWith("s") && text !== "synthesis" ? text.slice(0, -1) : text;
}

function firstHeading(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}

function summaryFromMarkdown(markdown) {
  const summary = markdown.match(/^## Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/m)?.[1] || "";
  const firstSummaryLine = firstUsefulLine(summary);
  if (firstSummaryLine) return firstSummaryLine;
  return firstUsefulLine(markdown.replace(/^---\n[\s\S]*?\n---/, ""));
}

function firstUsefulLine(markdown) {
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    return trimmed.replace(/^[-*]\s+/, "").slice(0, 180);
  }
  return "";
}

function updatedFromStat(file) {
  try {
    return fs.statSync(file).mtime.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
