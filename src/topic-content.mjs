import fs from "node:fs";
import path from "node:path";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function topicContent(config, input) {
  const vaultPath = resolveVault(config, input.vault);
  const topicRel = normalizeWikiRel(input.path);
  const topicTitle = String(input.title || titleFromRel(topicRel));
  const topicText = readPage(vaultPath, topicRel);
  if (!topicText) throw new Error(`Topic page not found: ${topicRel}`);

  const linked = parseWikiLinks(topicText);
  const linkedSources = linked.filter((rel) => rel.startsWith("wiki/sources/"));
  const inferredSources = linkedSources.length ? [] : findSourcePagesMentioning(vaultPath, topicRel, topicTitle);
  const sourceRels = unique([...(topicRel.startsWith("wiki/sources/") ? [topicRel] : []), ...linkedSources, ...inferredSources]);
  const otherRels = unique([
    ...(topicRel.startsWith("wiki/sources/") ? [] : [topicRel]),
    ...linked.filter((rel) => !rel.startsWith("wiki/sources/") && rel !== topicRel)
  ]);
  const ordered = [...sourceRels, ...otherRels].slice(0, 10);

  const lines = [
    `# ${topicTitle}`,
    "",
    "Related source pages are shown first, followed by the topic page and other linked wiki pages.",
    ""
  ];

  for (const rel of ordered) {
    const text = readPage(vaultPath, rel);
    if (!text) continue;
    lines.push(`## ${rel.startsWith("wiki/sources/") ? "Source" : "Related"}: ${titleFromMarkdown(text, rel)}`);
    lines.push(`${vaultName(vaultPath)} / ${rel}`);
    lines.push("");
    lines.push(truncate(cleanForDisplay(text), 3500));
    lines.push("");
  }

  if (ordered.length === 0) {
    lines.push("No related wiki pages were found.");
  }

  return lines.join("\n");
}

function resolveVault(config, name) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === name);
  if (!vaultPath) throw new Error(`Unknown vault: ${name}`);
  return vaultPath;
}

function normalizeWikiRel(value) {
  const rel = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..")) throw new Error(`Unsafe topic path: ${value}`);
  if (!rel.startsWith("wiki/")) throw new Error(`Topic path must be under wiki/: ${value}`);
  return rel.endsWith(".md") ? rel : `${rel}.md`;
}

function readPage(vaultPath, rel) {
  return readIfExists(path.join(vaultPath, rel));
}

function parseWikiLinks(markdown) {
  const links = [];
  for (const match of markdown.matchAll(/\[\[([^|\]#]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]/g)) {
    const rel = match[1].trim();
    if (!rel.startsWith("wiki/")) continue;
    links.push(rel.endsWith(".md") ? rel : `${rel}.md`);
  }
  return unique(links);
}

function findSourcePagesMentioning(vaultPath, topicRel, topicTitle) {
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  if (!fs.existsSync(sourceDir)) return [];
  const needles = [
    topicRel.replace(/\.md$/, ""),
    topicTitle.toLowerCase()
  ].filter(Boolean);
  const files = [];
  walk(sourceDir, files);
  return files
    .filter((file) => file.endsWith(".md"))
    .filter((file) => {
      const lower = readIfExists(file).toLowerCase();
      return needles.some((needle) => lower.includes(needle.toLowerCase()));
    })
    .map((file) => path.relative(vaultPath, file).replace(/\\/g, "/"))
    .slice(0, 4);
}

function cleanForDisplay(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/\n## User Notes[\s\S]*$/m, "")
    .trim();
}

function titleFromMarkdown(markdown, rel) {
  const title = markdown.match(/^#\s+(.+)$/m);
  return title ? title[1].trim() : titleFromRel(rel);
}

function titleFromRel(rel) {
  return path.basename(rel, path.extname(rel))
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max).trim()}\n\n[Content truncated in UI preview.]` : text;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function walk(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, result);
    else result.push(file);
  }
}
