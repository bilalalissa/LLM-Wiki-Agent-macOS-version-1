import fs from "node:fs";
import path from "node:path";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function listTopics(config) {
  const topics = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const vault = vaultName(vaultPath);
    const index = readIfExists(path.join(vaultPath, "index.md"));
    topics.push(...topicsFromIndex(vault, index));
  }
  return topics
    .filter((topic, index, all) => {
      const key = `${topic.vault}|${topic.path}`;
      return all.findIndex((item) => `${item.vault}|${item.path}` === key) === index;
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function topicsFromIndex(vault, index) {
  const topics = [];
  for (const line of index.split(/\r?\n/)) {
    if (!line.startsWith("| [[")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const link = parseWikiLink(cells[0]);
    if (!link) continue;
    topics.push({
      vault,
      title: link.title,
      path: link.path,
      type: cells[1],
      summary: cells[2],
      updated: cells[3]
    });
  }
  return topics;
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
