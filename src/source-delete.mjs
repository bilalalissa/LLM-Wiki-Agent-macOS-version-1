import fs from "node:fs";
import path from "node:path";
import { listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function deleteSources(config, sources) {
  const results = [];
  for (const source of sources) {
    results.push(archiveOneSource(config, source));
  }
  return results;
}

function archiveOneSource(config, source) {
  const vaultPath = resolveVault(config, source.vault);
  const rawRel = normalizeRel(source.file);
  const sourceRel = normalizeRel(source.sourcePage) || findSourcePageForRaw(vaultPath, rawRel);
  if (!rawRel && !sourceRel) throw new Error("Missing source file or source page.");

  const sourceNoExt = sourceRel ? sourceRel.replace(/\.md$/, "") : "";
  const archived = [];
  const updated = [];

  if (rawRel) archiveIfExists(vaultPath, rawRel, archiveRawRel(rawRel), archived);
  if (sourceRel) archiveIfExists(vaultPath, sourceRel, archiveWikiRel(sourceRel), archived);

  const relatedArchived = cleanupRelatedWikiPages(vaultPath, sourceNoExt, updated, archived);

  cleanupIndex(vaultPath, [sourceNoExt, ...relatedArchived.map((item) => item.from.replace(/\.md$/, ""))], updated);
  appendMaintenanceLog(vaultPath, { rawRel, sourceRel, archived, updated });

  return {
    vault: vaultName(vaultPath),
    raw: rawRel,
    sourcePage: sourceRel,
    archived,
    updated,
    status: archived.length ? "archived" : "nothing found to archive"
  };
}

function findSourcePageForRaw(vaultPath, rawRel) {
  if (!rawRel) return "";
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  const files = [];
  walk(sourceDir, files);
  const normalizedRaw = rawRel.replace(/\\/g, "/");
  for (const file of files.filter((item) => item.endsWith(".md"))) {
    const text = readIfExists(file);
    const match = text.match(/^source_path:\s*(.+)$/m);
    const sourcePath = match?.[1]?.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
    if (sourcePath === normalizedRaw) return path.relative(vaultPath, file).replace(/\\/g, "/");
  }
  return "";
}

function cleanupRelatedWikiPages(vaultPath, sourceNoExt, updated, archived) {
  if (!sourceNoExt) return [];
  const wikiDir = path.join(vaultPath, "wiki");
  const files = [];
  walk(wikiDir, files);
  const relatedArchived = [];
  const sourceLinkPattern = new RegExp(`\\[\\[${escapeRegExp(sourceNoExt)}(?:\\|[^\\]]+)?\\]\\]`, "g");

  for (const file of files.filter((item) => item.endsWith(".md"))) {
    const rel = path.relative(vaultPath, file);
    if (rel === `${sourceNoExt}.md`) continue;
    let text = readIfExists(file);
    if (!text.includes(sourceNoExt)) continue;

    if (isGeneratedOnlyFromSource(text, sourceNoExt) && (rel.startsWith("wiki/concepts/") || rel.startsWith("wiki/entities/"))) {
      const to = archiveWikiRel(rel);
      archiveIfExists(vaultPath, rel, to, archived);
      relatedArchived.push({ from: rel, to });
      continue;
    }

    const next = text
      .split(/\r?\n/)
      .filter((line) => !line.includes(sourceNoExt))
      .join("\n")
      .replace(sourceLinkPattern, "")
      .replace(/\n{3,}/g, "\n\n");

    if (next !== text) {
      fs.writeFileSync(file, next);
      updated.push(rel);
    }
  }
  return relatedArchived;
}

function isGeneratedOnlyFromSource(text, sourceNoExt) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return false;
  const sourceLinks = [...frontmatter[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]);
  return sourceLinks.length === 1 && sourceLinks[0] === sourceNoExt;
}

function cleanupIndex(vaultPath, pageRefs, updated) {
  const indexPath = path.join(vaultPath, "index.md");
  if (!fs.existsSync(indexPath)) return;
  const refs = pageRefs.filter(Boolean);
  const oldText = fs.readFileSync(indexPath, "utf8");
  const next = oldText
    .split(/\r?\n/)
    .filter((line) => !refs.some((ref) => line.includes(`[[${ref}`)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  if (next !== oldText) {
    fs.writeFileSync(indexPath, next);
    updated.push("index.md");
  }
}

function appendMaintenanceLog(vaultPath, { rawRel, sourceRel, archived, updated }) {
  const logPath = path.join(vaultPath, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `
## [${date}] maintenance | Archive processed source

Changed:
${archived.map((item) => `- Archived \`${item.from}\` to \`${item.to}\`.`).join("\n") || "- No files archived."}
${updated.map((item) => `- Updated \`${item}\`.`).join("\n") || "- No related files updated."}

Sources:
- \`${rawRel || "none"}\`
- \`${sourceRel || "none"}\`

Notes:
- Archived from the agent UI Files tab.
- Removed exact source references and index entries.

Next:
- Review affected wiki pages for any remaining claims that need manual cleanup.
`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Log\n";
  fs.writeFileSync(logPath, `${existing.trim()}\n${entry}\n`);
}

function resolveVault(config, name) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === name);
  if (!vaultPath) throw new Error(`Unknown vault: ${name}`);
  return vaultPath;
}

function normalizeRel(value) {
  if (!value) return "";
  const rel = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.includes("..")) throw new Error(`Unsafe path: ${value}`);
  return rel;
}

function archiveIfExists(vaultPath, fromRel, toRel, archived) {
  const from = path.join(vaultPath, fromRel);
  if (!fs.existsSync(from)) return;
  const to = uniquePath(path.join(vaultPath, toRel));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  archived.push({ from: fromRel, to: path.relative(vaultPath, to) });
}

function archiveRawRel(rawRel) {
  const base = path.basename(rawRel);
  if (rawRel.startsWith("raw/assets/")) return `raw/assets/archive/${base}`;
  return `raw/processed/archive/${base}`;
}

function archiveWikiRel(wikiRel) {
  return wikiRel.replace(/^wiki\//, "wiki/archive/");
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const parsed = path.parse(file);
  let index = 2;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function walk(dir, result) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, result);
    else result.push(file);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
