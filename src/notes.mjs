import fs from "node:fs";
import path from "node:path";
import { listVaults, listWikiFiles, slugify, vaultName } from "./vaults.mjs";

const START = "<!-- agent-note:";
const END = "<!-- /agent-note:";

export function listNotes(config) {
  const notes = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    for (const file of listWikiFiles(vaultPath)) {
      const relativePath = path.relative(vaultPath, file);
      if (!relativePath.startsWith(`wiki${path.sep}`)) continue;
      const text = fs.readFileSync(file, "utf8");
      notes.push(...parseNotes(text, vaultName(vaultPath), relativePath));
    }
  }
  return notes.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function addNote(config, input) {
  const target = resolveTarget(config, input.vault, input.path);
  const id = `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  const block = renderBlock({
    id,
    selectedText: input.selectedText,
    note: input.note,
    occurrence: input.occurrence,
    created: now,
    updated: now
  });
  const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : `# Agent UI Notes\n`;
  const next = existing.includes("## User Notes")
    ? `${existing.trim()}\n\n${block}\n`
    : `${existing.trim()}\n\n## User Notes\n\n${block}\n`;
  fs.writeFileSync(target.file, next);
  return { id, vault: target.vault, path: target.relativePath, selectedText: input.selectedText, note: input.note, occurrence: Number(input.occurrence || 0), created: now, updated: now };
}

export function updateNote(config, input) {
  const target = findNoteFile(config, input.id);
  if (!target) throw new Error(`Note not found: ${input.id}`);
  const text = fs.readFileSync(target.file, "utf8");
  const current = parseNotes(text, target.vault, target.relativePath).find((note) => note.id === input.id);
  if (!current) throw new Error(`Note not found: ${input.id}`);
  const updated = renderBlock({
    id: input.id,
    selectedText: input.selectedText ?? current.selectedText,
    note: input.note ?? current.note,
    occurrence: input.occurrence ?? current.occurrence,
    created: current.created,
    updated: new Date().toISOString()
  });
  fs.writeFileSync(target.file, replaceBlock(text, input.id, updated));
  return { ok: true };
}

export function deleteNote(config, id) {
  const target = findNoteFile(config, id);
  if (!target) throw new Error(`Note not found: ${id}`);
  const text = fs.readFileSync(target.file, "utf8");
  fs.writeFileSync(target.file, cleanupEmptyUserNotes(replaceBlock(text, id, "")).replace(/\n{3,}/g, "\n\n"));
  return { ok: true };
}

export function saveNoteMedia(config, input) {
  const target = resolveTarget(config, input.vault, input.path);
  const filename = safeFilename(input.filename || "note-media.bin");
  const dataUrl = String(input.data || "");
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]+)$/);
  if (!match) throw new Error("Unsupported media data.");
  const isBase64 = Boolean(match[2]);
  const bytes = isBase64 ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  if (bytes.length > 15 * 1024 * 1024) throw new Error("Media note attachment is larger than 15 MB.");

  const dirRel = "raw/assets/user-notes";
  const vaultRoot = resolveVaultPath(config, target.vault);
  const fullDir = path.join(vaultRoot, dirRel);
  fs.mkdirSync(fullDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const parsed = path.parse(filename);
  const outName = `${stamp}--${slugify(parsed.name)}${parsed.ext || ".bin"}`;
  const outPath = uniquePath(path.join(fullDir, outName));
  fs.writeFileSync(outPath, bytes);
  const rel = path.relative(vaultRoot, outPath).replace(/\\/g, "/");
  return {
    vault: target.vault,
    path: target.relativePath,
    file: rel,
    markdown: mediaMarkdown(rel, filename)
  };
}

function resolveTarget(config, vaultNameInput, relativePathInput) {
  const vaults = listVaults(config.vaultsRoot);
  let vaultPath = vaults.find((item) => vaultName(item) === vaultNameInput);
  let relativePath = relativePathInput;
  if (!vaultPath || !relativePath || !relativePath.startsWith("wiki/")) {
    vaultPath = vaults[0];
    relativePath = "wiki/questions/agent-ui-notes.md";
  }
  const file = path.join(vaultPath, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { vault: vaultName(vaultPath), relativePath, file };
}

function resolveVaultPath(config, name) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === name);
  if (!vaultPath) throw new Error(`Unknown vault: ${name}`);
  return vaultPath;
}

function findNoteFile(config, id) {
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    for (const file of listWikiFiles(vaultPath)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(`${START}${id} -->`)) {
        return { vault: vaultName(vaultPath), relativePath: path.relative(vaultPath, file), file };
      }
    }
  }
  return null;
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

function renderBlock(note) {
  return `${START}${note.id} -->
> [!note] Agent UI note
> **Selected:** ${singleLine(note.selectedText)}
> **Note:**
${quoteBlock(note.note)}
> **Occurrence:** ${Number(note.occurrence || 0)}
> **Created:** ${note.created}
> **Updated:** ${note.updated}
${END}${note.id} -->`;
}

function replaceBlock(text, id, replacement) {
  const regex = new RegExp(`<!-- agent-note:${escapeRegExp(id)} -->[\\s\\S]*?<!-- /agent-note:${escapeRegExp(id)} -->`);
  return text.replace(regex, replacement);
}

function cleanupEmptyUserNotes(text) {
  return text.replace(/\n*## User Notes\s*$/, "");
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function quoteBlock(value) {
  const text = String(value || "").trim();
  return (text || " ").split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function safeFilename(value) {
  const parsed = path.parse(String(value || "note-media.bin").replace(/[/\\]/g, "-"));
  return `${slugify(parsed.name)}${parsed.ext || ".bin"}`;
}

function mediaMarkdown(rel, originalName) {
  const ext = path.extname(rel).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".mp3", ".wav", ".m4a", ".aiff", ".mp4", ".mov", ".m4v"].includes(ext)) {
    return `![[${rel}]]`;
  }
  return `[${originalName || path.basename(rel)}](${rel})`;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
