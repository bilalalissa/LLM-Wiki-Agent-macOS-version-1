import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function listVaults(root) {
  return uniquePaths([
    ...listVaultsUnderRoot(root),
    ...listObsidianVaults()
  ]).sort((a, b) => vaultName(a).localeCompare(vaultName(b), undefined, { sensitivity: "base" }));
}

function listVaultsUnderRoot(root) {
  const resolvedRoot = path.resolve(expandTilde(root || "."));
  if (!isDirectory(resolvedRoot)) return [];
  return fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isVaultDirectory(path.join(resolvedRoot, entry.name), entry.name))
    .map((entry) => path.join(resolvedRoot, entry.name));
}

export function listObsidianVaults() {
  const registryFile = process.env.OBSIDIAN_VAULTS_FILE ||
    path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  const registry = readJson(registryFile);
  const vaults = registry?.vaults && typeof registry.vaults === "object" ? Object.values(registry.vaults) : [];
  return vaults
    .map((entry) => typeof entry === "string" ? entry : entry?.path)
    .filter(Boolean)
    .map((item) => path.resolve(expandTilde(item)))
    .filter(isDirectory);
}

function isVaultDirectory(vaultPath, name) {
  return name.endsWith("-vault") ||
    fs.existsSync(path.join(vaultPath, ".obsidian")) ||
    fs.existsSync(path.join(vaultPath, "AGENTS.md")) ||
    fs.existsSync(path.join(vaultPath, "CLAUDE.md"));
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    let key;
    try {
      key = fs.realpathSync(item);
    } catch {
      key = path.resolve(item);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function expandTilde(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
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
  return String(input || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "") || "untitled";
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
