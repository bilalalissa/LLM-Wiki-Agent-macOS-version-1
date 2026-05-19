import fs from "node:fs";
import path from "node:path";
import { createProvider } from "./provider.mjs";
import {
  ensureDir,
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

function appendLog(vaultPath, { date, sourceRel, sourcePath, processedRel, sourceTitle, conceptPages, receivedAt }) {
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
- Ingested from \`${relSource}\` and moved to \`${processedRel}\`.
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
