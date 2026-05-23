import fs from "node:fs";
import path from "node:path";
import { ensureDir, listVaults, readIfExists, slugify, vaultName } from "./vaults.mjs";

export function renameSource(config, payload) {
  const vaultPath = resolveVault(config, payload.vault);
  const rawRel = normalizeRel(payload.file);
  const sourceRel = normalizeRel(payload.sourcePage) || findSourcePageForRaw(vaultPath, rawRel);
  const title = String(payload.title || "").trim();
  if (!title) throw new Error("New source title is required.");
  if (!rawRel && !sourceRel) throw new Error("Missing source file or source page.");

  const rawMove = rawRel ? moveIfExists(vaultPath, rawRel, renamedRel(rawRel, title)) : null;
  const sourceMove = sourceRel ? moveIfExists(vaultPath, sourceRel, renamedSourcePageRel(sourceRel, title, rawMove?.to)) : null;
  const newRawRel = rawMove?.to || rawRel;
  const newSourceRel = sourceMove?.to || sourceRel;
  const oldSourceNoExt = sourceRel ? sourceRel.replace(/\.md$/, "") : "";
  const newSourceNoExt = newSourceRel ? newSourceRel.replace(/\.md$/, "") : "";

  const updated = updateMarkdownReferences(vaultPath, {
    title,
    rawRel,
    newRawRel,
    sourceRel,
    newSourceRel,
    oldSourceNoExt,
    newSourceNoExt
  });

  appendRenameLog(vaultPath, {
    title,
    rawMove,
    sourceMove,
    updated
  });

  return {
    vault: vaultName(vaultPath),
    raw: rawMove || null,
    sourcePage: sourceMove || null,
    updated,
    status: "renamed"
  };
}

function updateMarkdownReferences(vaultPath, refs) {
  const files = [];
  collectMarkdown(vaultPath, files);
  const updated = [];
  for (const file of files) {
    const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
    let text = readIfExists(file);
    let next = text;

    if (refs.rawRel && refs.newRawRel) next = replaceAll(next, refs.rawRel, refs.newRawRel);
    if (refs.sourceRel && refs.newSourceRel) next = replaceAll(next, refs.sourceRel, refs.newSourceRel);
    if (refs.oldSourceNoExt && refs.newSourceNoExt) next = replaceAll(next, refs.oldSourceNoExt, refs.newSourceNoExt);
    if (refs.newSourceNoExt) next = updateSourceLinkAliases(next, refs.newSourceNoExt, refs.title);

    if (rel === refs.newSourceRel) {
      next = updateSourcePageTitle(next, refs.title);
      if (refs.newRawRel) next = updateFrontmatterValue(next, "source_path", refs.newRawRel);
      next = updateFrontmatterValue(next, "updated", new Date().toISOString().slice(0, 10));
    }

    if (next !== text) {
      fs.writeFileSync(file, next);
      updated.push(rel);
    }
  }
  return [...new Set(updated)].sort();
}

function updateSourceLinkAliases(markdown, sourceNoExt, title) {
  const pattern = new RegExp(`\\[\\[${escapeRegExp(sourceNoExt)}\\|[^\\]]+\\]\\]`, "g");
  return markdown.replace(pattern, `[[${sourceNoExt}|${title}]]`);
}

function moveIfExists(vaultPath, fromRel, toRel) {
  const from = path.join(vaultPath, fromRel);
  if (!fs.existsSync(from)) return null;
  const to = uniquePath(path.join(vaultPath, toRel));
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
  return {
    from: fromRel,
    to: path.relative(vaultPath, to).replace(/\\/g, "/")
  };
}

function renamedRel(rel, title) {
  const parsed = path.parse(rel);
  const prefix = datePrefix(parsed.name);
  return path.join(parsed.dir, `${prefix}${slugify(title)}${parsed.ext}`).replace(/\\/g, "/");
}

function renamedSourcePageRel(sourceRel, title, rawToRel) {
  if (rawToRel) {
    const parsedRaw = path.parse(rawToRel);
    return path.join("wiki", "sources", `${parsedRaw.name}.md`).replace(/\\/g, "/");
  }
  return renamedRel(sourceRel, title);
}

function datePrefix(name) {
  const match = name.match(/^(\d{4}-\d{2}-\d{2}--)/);
  return match ? match[1] : "";
}

function updateSourcePageTitle(markdown, title) {
  if (/^#\s+.+$/m.test(markdown)) return markdown.replace(/^#\s+.+$/m, `# ${title}`);
  return `# ${title}\n\n${markdown}`;
}

function updateFrontmatterValue(markdown, key, value) {
  const pattern = new RegExp(`^(---\\n[\\s\\S]*?\\n)${escapeRegExp(key)}:\\s*.*$`, "m");
  if (pattern.test(markdown)) return markdown.replace(pattern, `$1${key}: ${value}`);
  if (/^---\n/.test(markdown)) return markdown.replace(/^---\n/, `---\n${key}: ${value}\n`);
  return markdown;
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

function appendRenameLog(vaultPath, { title, rawMove, sourceMove, updated }) {
  const logPath = path.join(vaultPath, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `
## [${date}] maintenance | Rename processed source

Changed:
${rawMove ? `- Renamed raw source \`${rawMove.from}\` to \`${rawMove.to}\`.` : "- No raw source file renamed."}
${sourceMove ? `- Renamed source page \`${sourceMove.from}\` to \`${sourceMove.to}\`.` : "- No source page renamed."}
${updated.map((item) => `- Updated references in \`${item}\`.`).join("\n") || "- No markdown references needed updates."}

New title:
- ${title}
`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Log\n";
  fs.writeFileSync(logPath, `${existing.trim()}\n${entry}\n`);
}

function collectMarkdown(vaultPath, result) {
  for (const rel of ["index.md", "log.md", "AGENTS.md", "CLAUDE.md", "wiki"]) {
    const file = path.join(vaultPath, rel);
    if (!fs.existsSync(file)) continue;
    if (fs.statSync(file).isDirectory()) walk(file, result);
    else if (file.endsWith(".md")) result.push(file);
  }
}

function walk(dir, result) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, result);
    else if (file.endsWith(".md")) result.push(file);
  }
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

function replaceAll(value, from, to) {
  return String(value).split(from).join(to);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
