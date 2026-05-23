import fs from "node:fs";
import path from "node:path";
import { ensureDir, isTextRawFile, listVaults, readIfExists, slugify, vaultName } from "./vaults.mjs";

export function mergeSources(config, payload) {
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  if (sources.length < 2) throw new Error("Select at least two sources to merge.");

  const vaultNames = [...new Set(sources.map((item) => String(item.vault || "")))].filter(Boolean);
  if (vaultNames.length !== 1) throw new Error("Merge sources from one vault at a time.");

  const vaultPath = resolveVault(config, vaultNames[0]);
  const title = String(payload.title || "Merged source").trim() || "Merged source";
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rel = path.join("raw", "input", `${stamp}--merged--${slugify(title)}.md`);
  const fullPath = uniquePath(path.join(vaultPath, rel));
  ensureDir(path.dirname(fullPath));

  const normalizedSources = sources.map((source) => ({
    vault: vaultName(vaultPath),
    file: normalizeRel(source.file),
    sourcePage: normalizeRel(source.sourcePage)
  }));

  fs.writeFileSync(fullPath, renderMergedSource({
    title,
    now,
    vaultPath,
    sources: normalizedSources
  }));

  const outputRel = path.relative(vaultPath, fullPath).replace(/\\/g, "/");
  appendMergeLog(vaultPath, {
    title,
    outputRel,
    sources: normalizedSources,
    originalAction: payload.originalAction
  });

  return {
    vault: vaultName(vaultPath),
    file: outputRel,
    sourceCount: normalizedSources.length
  };
}

function renderMergedSource({ title, now, vaultPath, sources }) {
  return `---
type: merged-source
created: ${now.toISOString()}
source: agent-ui-source-merge
merged_from:
${sources.map((source) => `  - raw: ${source.file || "none"}\n    source_page: ${source.sourcePage || "none"}`).join("\n")}
---

# ${title}

## Merge Intent

This source combines multiple already-processed sources so the LLM Wiki agent can ingest them as one consolidated source and update linked wiki files around the merged synthesis.

## Original Sources

${sources.map((source, index) => `- ${index + 1}. Raw: \`${source.file || "none"}\`; source page: \`${source.sourcePage || "none"}\``).join("\n")}

${sources.map((source, index) => renderSourceSection(vaultPath, source, index + 1)).join("\n\n")}
`;
}

function renderSourceSection(vaultPath, source, number) {
  const sourcePageText = source.sourcePage ? readIfExists(path.join(vaultPath, source.sourcePage)) : "";
  const rawPath = source.file ? path.join(vaultPath, source.file) : "";
  const rawText = rawPath && fs.existsSync(rawPath) && isTextRawFile(rawPath)
    ? readIfExists(rawPath)
    : "";
  const rawNote = rawPath && fs.existsSync(rawPath) && !isTextRawFile(rawPath)
    ? `Raw file is non-text media and is referenced by path only: \`${source.file}\`.`
    : "";

  return `## Source ${number}: ${sourceTitle(sourcePageText, source)}

### Source Paths

- Raw source: \`${source.file || "none"}\`
- Source page: \`${source.sourcePage || "none"}\`

### Processed Source Page

${sourcePageText.trim() || "No processed source page text found."}

### Original Raw Text

${rawText.trim() || rawNote || "No readable raw text found."}`;
}

function sourceTitle(markdown, source) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    path.basename(source.file || source.sourcePage || "Untitled", path.extname(source.file || source.sourcePage || ""));
}

function appendMergeLog(vaultPath, { title, outputRel, sources, originalAction }) {
  const logPath = path.join(vaultPath, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `
## [${date}] maintenance | Merge processed sources

Changed:
- Created merged raw source \`${outputRel}\`.
- Original handling: ${originalAction === "archive" ? "archive originals after merge" : "keep originals active"}.

Sources:
${sources.map((source) => `- \`${source.file || "none"}\` / \`${source.sourcePage || "none"}\``).join("\n")}

Notes:
- Merged source title: ${title}
- The merged source is placed in \`raw/input/\` for auto-ingest.
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
