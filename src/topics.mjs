import fs from "node:fs";
import path from "node:path";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function listTopics(config) {
  const topics = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
    topics.push(...topicsFromIndex(vaultPath, vault, index));
  }
  return topics
    .filter((topic, index, all) => {
      const key = `${topic.vault}|${topic.path}`;
      return all.findIndex((item) => `${item.vault}|${item.path}` === key) === index;
    })
    .sort((a, b) => a.title.localeCompare(b.title));
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

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { tags: [], created: "" };
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
  const created = block.match(/^created:\s*(.+)$/m)?.[1]?.trim() || "";
  return { tags: [...new Set(tags)], created };
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
