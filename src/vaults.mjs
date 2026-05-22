import fs from "node:fs";
import path from "node:path";

export function listVaults(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isVaultDirectory(path.join(root, entry.name), entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function isVaultDirectory(vaultPath, name) {
  return name.endsWith("-vault") ||
    fs.existsSync(path.join(vaultPath, ".obsidian")) ||
    fs.existsSync(path.join(vaultPath, "AGENTS.md")) ||
    fs.existsSync(path.join(vaultPath, "CLAUDE.md"));
}

export function vaultName(vaultPath) {
  return path.basename(vaultPath);
}

export function readVaultContract(vaultPath) {
  return readIfExists(path.join(vaultPath, "AGENTS.md"));
}

export function readVaultIndex(vaultPath) {
  return readIfExists(path.join(vaultPath, "index.md"));
}

export function readVaultLog(vaultPath) {
  return readIfExists(path.join(vaultPath, "log.md"));
}

export function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function listRawCandidates(vaultPath) {
  const rawDir = path.join(vaultPath, "raw");
  if (!fs.existsSync(rawDir)) return [];
  const result = [];
  walk(rawDir, result);
  return result.filter((file) => {
    const rel = path.relative(rawDir, file);
    if (rel.startsWith(`processed${path.sep}`)) return false;
    if (rel.startsWith(`assets${path.sep}`)) return false;
    return isIngestibleRawFile(file);
  });
}

const ingestibleExtensions = new Set([
  ".md",
  ".txt",
  ".markdown",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
  ".mp3",
  ".wav",
  ".m4a",
  ".aiff",
  ".mp4",
  ".mov",
  ".m4v"
]);

export function isIngestibleRawFile(file) {
  return ingestibleExtensions.has(path.extname(file).toLowerCase());
}

export function isTextRawFile(file) {
  return new Set([".md", ".txt", ".markdown"]).has(path.extname(file).toLowerCase());
}

export function isMediaRawFile(file) {
  return isIngestibleRawFile(file) && !isTextRawFile(file);
}

function walk(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file, result);
    } else {
      result.push(file);
    }
  }
}

export function listWikiFiles(vaultPath) {
  const wikiDir = path.join(vaultPath, "wiki");
  const result = [];
  if (fs.existsSync(wikiDir)) walk(wikiDir, result);
  for (const name of ["index.md", "log.md", "Welcome.md"]) {
    const file = path.join(vaultPath, name);
    if (fs.existsSync(file)) result.push(file);
  }
  return result.filter((file) => file.endsWith(".md"));
}
