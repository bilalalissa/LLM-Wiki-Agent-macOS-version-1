import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.mjs";
import { listVaults, vaultName } from "./vaults.mjs";

const sectionNames = [
  "Open Questions",
  "Contradictions",
  "Source's Related Learning Questions",
  "Open Learning Questions"
];

export function backfillLearningSections(config = getConfig()) {
  const results = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    const files = [];
    const wikiDir = path.join(vaultPath, "wiki");
    if (fs.existsSync(wikiDir)) walk(wikiDir, files);
    for (const file of files.filter((item) => item.endsWith(".md") && !item.includes(`${path.sep}archive${path.sep}`))) {
      const before = fs.readFileSync(file, "utf8");
      const after = ensureLearningSections(before, path.relative(vaultPath, file));
      if (after !== before) {
        fs.writeFileSync(file, after);
        results.push({ vault: vaultName(vaultPath), file: path.relative(vaultPath, file) });
      }
    }
  }
  return results;
}

function ensureLearningSections(markdown, rel) {
  const title = extractTitle(markdown, rel);
  const userNotes = markdown.match(/\n## User Notes[\s\S]*$/m)?.[0] || "";
  let body = userNotes ? markdown.slice(0, -userNotes.length).trimEnd() : markdown.trimEnd();
  body = repairStrandedKeyPoints(body);

  const sourceLearning = extractSection(body, "Source's Related Learning Questions") ||
    `## Source's Related Learning Questions\n\n${sourceLearningQuestions(title)}`;
  const openLearning = extractSection(body, "Open Learning Questions") ||
    `## Open Learning Questions\n\n${openLearningQuestions(title)}`;

  body = removeSection(removeSection(body, "Source's Related Learning Questions"), "Open Learning Questions").trimEnd();
  const learningBlock = `${sourceLearning.trim()}\n\n${openLearning.trim()}`;
  const next = insertAfterKeyPoints(body, learningBlock);
  return `${next}${userNotes ? `\n${userNotes}` : ""}\n`;
}

function repairStrandedKeyPoints(markdown) {
  const pattern = /## Key Points\s*\n(?<key>[\s\S]*?)\n## Source's Related Learning Questions\s*\n(?<source>[\s\S]*?)\n## Open Learning Questions\s*\n(?<open>[\s\S]*?)(?=\n##\s+|$)/;
  const match = markdown.match(pattern);
  if (!match?.groups) return markdown;

  const openLines = match.groups.open.trimEnd().split(/\r?\n/);
  const questionLines = [];
  const sourceLines = match.groups.source.trimEnd().split(/\r?\n/).filter((line) => line.trim());
  const stranded = [];
  let inStranded = false;
  for (const line of openLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!inStranded) questionLines.push(line);
    } else if (!inStranded && isDefaultSourceLearningLine(trimmed)) {
      sourceLines.push(line);
    } else if (!inStranded && /\?\s*$/.test(trimmed)) {
      questionLines.push(line);
    } else {
      inStranded = true;
      stranded.push(line);
    }
  }
  if (!stranded.some((line) => line.trim())) return markdown;

  const key = [match.groups.key.trimEnd(), stranded.join("\n").trim()].filter(Boolean).join("\n");
  const replacement = `## Key Points\n${key}\n\n## Source's Related Learning Questions\n${dedupeLines(sourceLines).join("\n").trimEnd()}\n\n## Open Learning Questions\n${dedupeLines(questionLines).join("\n").trimEnd()}`;
  return markdown.replace(pattern, replacement);
}

function isDefaultSourceLearningLine(line) {
  return /without reopening the source\?|deserve practice or follow-up notes\?/i.test(line);
}

function dedupeLines(lines) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const key = line.trim();
    if (!key) {
      if (result[result.length - 1]?.trim()) result.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

function hasSection(markdown, name) {
  return new RegExp(`^##\\s+${escapeRegExp(name)}\\s*$`, "m").test(markdown);
}

function extractSection(markdown, name) {
  const match = markdown.match(sectionPattern(name));
  return match ? match[0].trim() : "";
}

function removeSection(markdown, name) {
  return markdown.replace(sectionPattern(name), "").replace(/\n{3,}/g, "\n\n");
}

function sectionPattern(name) {
  return new RegExp(`\\n?##\\s+${escapeRegExp(name)}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`);
}

function insertAfterKeyPoints(markdown, block) {
  const keyPoints = markdown.match(sectionPattern("Key Points"));
  if (!keyPoints) return `${markdown.trimEnd()}\n\n${block}`;
  const index = keyPoints.index + keyPoints[0].length;
  return `${markdown.slice(0, index).trimEnd()}\n\n${block}\n\n${markdown.slice(index).trimStart()}`.trimEnd();
}

function extractTitle(markdown, rel) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    path.basename(rel, ".md").replace(/^\d{4}-\d{2}-\d{2}--/, "").replace(/-/g, " ");
}

function sourceLearningQuestions(title) {
  return [
    `- What should I be able to explain from "${title}" without reopening the source?`,
    `- Which examples, definitions, claims, or procedures in "${title}" deserve practice or follow-up notes?`
  ].join("\n");
}

function openLearningQuestions(title) {
  return [
    `- How does "${title}" connect to adjacent domains, real-world systems, or global context?`,
    `- What newer, broader, or conflicting source would most improve my understanding of "${title}"?`
  ].join("\n");
}

function walk(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, result);
    else result.push(file);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = backfillLearningSections();
  for (const result of results) {
    console.log(`[${result.vault}] ${result.file}`);
  }
  console.log(`Updated ${results.length} file${results.length === 1 ? "" : "s"}.`);
}
