import fs from "node:fs";
import path from "node:path";
import { createProvider } from "./provider.mjs";
import {
  ensureDir,
  isMediaRawFile,
  listRawCandidates,
  readVaultContract,
  readVaultIndex,
  slugify,
  today,
  vaultName
} from "./vaults.mjs";

export async function ingestVault(vaultPath, config, provider = createProvider(config)) {
  const candidates = listRawCandidates(vaultPath);
  const results = [];
  for (const sourcePath of candidates) {
    results.push(await ingestFile(vaultPath, sourcePath, config, provider));
  }
  return results;
}

export async function ingestFile(vaultPath, sourcePath, config, provider = createProvider(config)) {
  const receivedAt = new Date();
  if (isMediaRawFile(sourcePath)) {
    return ingestMediaFile(vaultPath, sourcePath, receivedAt);
  }
  const sourceText = fs.readFileSync(sourcePath, "utf8").slice(0, config.ingestMaxChars);
  const contract = readVaultContract(vaultPath);
  const index = readVaultIndex(vaultPath);
  const sourceTitle = extractTitle(sourceText, sourcePath);
  const date = today();
  const slug = slugify(sourceTitle);
  const processedRel = `raw/processed/${date}--${slug}.md`;
  const sourceRel = `wiki/sources/${date}--${slug}.md`;

  const analysis = await analyzeSource(provider, {
    contract,
    index,
    sourceTitle,
    sourcePath: path.relative(vaultPath, sourcePath),
    sourceText
  });

  ensureDir(path.join(vaultPath, "wiki/sources"));
  ensureDir(path.join(vaultPath, "wiki/concepts"));
  ensureDir(path.join(vaultPath, "raw/processed"));

  const sourcePagePath = path.join(vaultPath, sourceRel);
  fs.writeFileSync(sourcePagePath, renderSourcePage({ date, sourceTitle, processedRel, analysis }));

  const conceptPages = [];
  for (const concept of analysis.concepts.slice(0, 8)) {
    const conceptSlug = slugify(concept.name);
    const conceptPath = path.join(vaultPath, "wiki/concepts", `${conceptSlug}.md`);
    if (!fs.existsSync(conceptPath)) {
      fs.writeFileSync(conceptPath, renderConceptPage({ date, concept, sourceRel }));
      conceptPages.push(`wiki/concepts/${conceptSlug}.md`);
    }
  }

  updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages });
  appendLog(vaultPath, { date, sourceRel, sourcePath, processedRel, sourceTitle, conceptPages, receivedAt });

  const processedPath = path.join(vaultPath, processedRel);
  if (path.resolve(sourcePath) !== path.resolve(processedPath)) {
    fs.renameSync(sourcePath, processedPath);
  }

  return {
    vault: vaultName(vaultPath),
    source: path.relative(vaultPath, sourcePath),
    sourcePage: sourceRel,
    processed: processedRel,
    conceptPages
  };
}

function ingestMediaFile(vaultPath, sourcePath, receivedAt) {
  const date = today();
  const ext = path.extname(sourcePath).toLowerCase();
  const sourceTitle = path.basename(sourcePath, ext);
  const slug = slugify(sourceTitle);
  const assetRel = uniqueRel(vaultPath, `raw/assets/${date}--${slug}${ext}`);
  const sourceRel = uniqueRel(vaultPath, `wiki/sources/${date}--${slug}.md`);
  const mediaKind = mediaKindFor(ext);
  const sourcePagePath = path.join(vaultPath, sourceRel);
  const assetPath = path.join(vaultPath, assetRel);

  ensureDir(path.dirname(assetPath));
  ensureDir(path.dirname(sourcePagePath));
  fs.renameSync(sourcePath, assetPath);

  fs.writeFileSync(sourcePagePath, renderMediaSourcePage({
    date,
    sourceTitle,
    assetRel,
    mediaKind,
    ext
  }));

  const analysis = {
    summary: `${mediaKind} source preserved as a local asset for later review and synthesis.`,
    concepts: [],
    key_points: []
  };
  updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages: [] });
  appendLog(vaultPath, {
    date,
    sourceRel,
    sourcePath,
    processedRel: assetRel,
    sourceTitle,
    conceptPages: [],
    receivedAt,
    sourceKind: mediaKind
  });

  return {
    vault: vaultName(vaultPath),
    source: path.relative(vaultPath, sourcePath),
    sourcePage: sourceRel,
    processed: assetRel,
    conceptPages: []
  };
}

function uniqueRel(vaultPath, initialRel) {
  const parsed = path.parse(initialRel);
  let rel = initialRel;
  let counter = 2;
  while (fs.existsSync(path.join(vaultPath, rel))) {
    rel = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`).replace(/\\/g, "/");
    counter += 1;
  }
  return rel.replace(/\\/g, "/");
}

function mediaKindFor(ext) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aiff"].includes(ext)) return "audio";
  if (ext === ".pdf") return "PDF";
  return "media";
}

async function analyzeSource(provider, input) {
  const prompt = `You are maintaining an Obsidian LLM Wiki.

Vault contract:
${input.contract}

Current index:
${input.index}

Source path: ${input.sourcePath}
Source title: ${input.sourceTitle}

Return strict JSON with this shape:
{
  "summary": "short paragraph",
  "key_points": ["durable point"],
  "concepts": [{"name": "Concept Name", "summary": "one sentence"}],
  "entities": [{"name": "Entity Name", "summary": "one sentence"}],
  "open_questions": ["question"],
  "contradictions": ["contradiction or empty"]
}

Source text:
${input.sourceText}`;

  const text = await provider.complete([
    { role: "system", content: "Return only valid JSON. Preserve source traceability. Do not invent facts." },
    { role: "user", content: prompt }
  ]);
  return parseJson(text);
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const data = JSON.parse(cleaned);
  return {
    summary: String(data.summary || ""),
    key_points: asArray(data.key_points),
    concepts: asArray(data.concepts).map(normalizeNamed),
    entities: asArray(data.entities).map(normalizeNamed),
    open_questions: asArray(data.open_questions),
    contradictions: asArray(data.contradictions)
  };
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeNamed(value) {
  if (typeof value === "string") return { name: value, summary: "" };
  return { name: String(value.name || "Untitled"), summary: String(value.summary || "") };
}

function extractTitle(text, sourcePath) {
  const frontmatterTitle = text.match(/^---[\s\S]*?\ntitle:\s*["']?(.+?)["']?\n[\s\S]*?---/);
  if (frontmatterTitle) return frontmatterTitle[1].trim();
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(sourcePath, path.extname(sourcePath));
}

function renderSourcePage({ date, sourceTitle, processedRel, analysis }) {
  return `---
type: source
status: active
created: ${date}
updated: ${date}
source_path: ${processedRel}
sources: []
tags:
  - llm-wiki
  - source
---

# ${sourceTitle}

## Summary

${analysis.summary}

## Key Points

${bulletList(analysis.key_points)}

## Evidence

- Source file: \`${processedRel}\`

## Links

${analysis.concepts.map((concept) => `- [[wiki/concepts/${slugify(concept.name)}|${concept.name}]]`).join("\n") || "- "}

## Open Questions

${bulletList(analysis.open_questions)}

## Contradictions

${bulletList(analysis.contradictions.length ? analysis.contradictions : ["None yet."])}
`;
}

function renderMediaSourcePage({ date, sourceTitle, assetRel, mediaKind, ext }) {
  const preview = mediaKind === "image" ? `\n![[${assetRel}]]\n` : "";
  return `---
type: source
status: active
created: ${date}
updated: ${date}
source_path: ${assetRel}
media_kind: ${mediaKind}
sources: []
tags:
  - llm-wiki
  - source
  - media
  - ${mediaKind.toLowerCase()}
---

# ${sourceTitle}

## Summary

${mediaKind} source preserved as a local asset. Review the media and add a human or AI-assisted description if its visual/audio content is important for later synthesis.

## Media
${preview}
- File: [[${assetRel}]]
- Kind: ${mediaKind}
- Extension: \`${ext}\`

## Key Points

- Local media has been moved into \`raw/assets/\` so Obsidian can keep it with the vault.
- This page is the traceable wiki source for the media file.

## Evidence

- Source file: \`${assetRel}\`

## Links

- 

## Open Questions

- What does this media show or prove?

## Contradictions

None yet.
`;
}

function renderConceptPage({ date, concept, sourceRel }) {
  return `---
type: concept
status: active
created: ${date}
updated: ${date}
sources:
  - [[${sourceRel.replace(/\.md$/, "")}]]
tags:
  - llm-wiki
---

# ${concept.name}

## Summary

${concept.summary}

## Evidence

- Seeded by [[${sourceRel.replace(/\.md$/, "")}]].

## Links

- [[${sourceRel.replace(/\.md$/, "")}]]

## Open Questions

- 

## Contradictions

None yet.
`;
}

function updateIndex(vaultPath, { date, sourceRel, sourceTitle, analysis, conceptPages }) {
  const indexPath = path.join(vaultPath, "index.md");
  let index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "# Index\n\n";
  const sourceLine = `| [[${sourceRel.replace(/\.md$/, "")}]] | source | ${escapePipe(analysis.summary || sourceTitle)} | ${date} |`;
  index = insertTableLine(index, "## Sources", sourceLine);
  for (const conceptPage of conceptPages) {
    const slug = path.basename(conceptPage, ".md");
    const concept = analysis.concepts.find((item) => slugify(item.name) === slug);
    if (!concept) continue;
    const line = `| [[${conceptPage.replace(/\.md$/, "")}|${concept.name}]] | concept | ${escapePipe(concept.summary)} | ${date} |`;
    index = insertTableLine(index, "## Concepts", line);
  }
  fs.writeFileSync(indexPath, index);
}

function insertTableLine(text, heading, line) {
  if (text.includes(line)) return text;
  const start = text.indexOf(heading);
  if (start === -1) return `${text.trim()}\n\n${heading}\n\n| Page | Type | Summary | Updated |\n| --- | --- | --- | --- |\n${line}\n`;
  const next = text.indexOf("\n## ", start + heading.length);
  const end = next === -1 ? text.length : next;
  const before = text.slice(0, end).replace(/\s+$/, "");
  const after = text.slice(end);
  return `${before}\n${line}${after}`;
}

function appendLog(vaultPath, { date, sourceRel, sourcePath, processedRel, sourceTitle, conceptPages, receivedAt, sourceKind = "text" }) {
  const logPath = path.join(vaultPath, "log.md");
  const relSource = path.relative(vaultPath, sourcePath);
  const processedAt = new Date();
  const entry = `
## [${date}] ingest | ${sourceTitle}

Changed:
- Added source summary \`${sourceRel}\`.
${conceptPages.map((page) => `- Added concept page \`${page}\`.`).join("\n") || "- No new concept pages created."}
- Updated \`index.md\`.

Sources:
- \`${processedRel}\`

Notes:
- Ingested ${sourceKind} source from \`${relSource}\` and moved to \`${processedRel}\`.
- Received at: ${formatLocal(receivedAt)}
- Processed at: ${formatLocal(processedAt)}

Next:
- Review the source summary and ask follow-up questions if useful.
`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Log\n";
  fs.writeFileSync(logPath, `${existing.trim()}\n${entry}\n`);
}

function formatLocal(date) {
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + (zone ? ` ${zone}` : "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function bulletList(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- ";
}

function escapePipe(text) {
  return String(text).replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 180);
}
