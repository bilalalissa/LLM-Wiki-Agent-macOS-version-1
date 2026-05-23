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
  const userNotes = markdown.match(/\n## User Notes[\s\S]*$/m)?.[0]?.trimEnd() || "";
  let body = userNotes ? markdown.slice(0, -userNotes.length).trimEnd() : markdown.trimEnd();
  body = repairStrandedKeyPoints(body);
  body = repairLearningLinesInKeyPoints(body);

  const openQuestions = renderLearningSection(
    "Open Questions",
    questionItemsFromSection(extractSection(body, "Open Questions"), title, body),
    "openQuestion",
    title,
    body
  );
  const sourceLearning = renderLearningSection(
    "Source's Related Learning Questions",
    learningItemsFromSection(extractSection(body, "Source's Related Learning Questions"), "source", title, body),
    "source",
    title,
    body
  );
  const openLearning = renderLearningSection(
    "Open Learning Questions",
    learningItemsFromSection(extractSection(body, "Open Learning Questions"), "open", title, body),
    "open",
    title,
    body
  );

  body = removeSection(removeSection(removeSection(body, "Open Questions"), "Source's Related Learning Questions"), "Open Learning Questions").trimEnd();
  const learningBlock = `${sourceLearning.trim()}\n\n${openLearning.trim()}`;
  const next = insertBeforeSection(insertAfterKeyPoints(body, learningBlock), "Contradictions", openQuestions);
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
    } else if (!inStranded && isLearningAnswerLine(trimmed)) {
      questionLines.push(line);
    } else if (!inStranded && isLearningQuestionLine(trimmed)) {
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

function isLearningQuestionLine(line) {
  return /^-\s*(?:Q:\s*)?.+\?\s*$/i.test(line);
}

function isLearningAnswerLine(line) {
  return /^(?:-\s*)?A:\s*.+/i.test(line);
}

function repairLearningLinesInKeyPoints(markdown) {
  const keyPoints = extractSection(markdown, "Key Points");
  if (!keyPoints) return markdown;
  const lines = keyPoints.split(/\r?\n/);
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    return !isLearningQuestionLine(trimmed) && !isLearningAnswerLine(trimmed);
  }).join("\n");
  if (cleaned === keyPoints) return markdown;
  return markdown.replace(keyPoints, cleaned);
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

function insertBeforeSection(markdown, heading, block) {
  const section = markdown.match(sectionPattern(heading));
  if (!section) return `${markdown.trimEnd()}\n\n${block.trim()}`.trimEnd();
  const index = section.index;
  return `${markdown.slice(0, index).trimEnd()}\n\n${block.trim()}\n\n${markdown.slice(index).trimStart()}`.trimEnd();
}

function extractTitle(markdown, rel) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    path.basename(rel, ".md").replace(/^\d{4}-\d{2}-\d{2}--/, "").replace(/-/g, " ");
}

function renderLearningSection(heading, items, kind, title, markdown) {
  const normalized = items.length ? items : defaultLearningItems(kind, title, markdown);
  return `## ${heading}\n\n${normalized.map((item) => {
    const question = item.question || defaultQuestion(kind, title);
    const answer = cleanAnswer(item.answer || answerForQuestion(question, kind, title, markdown));
    return `- Q: ${question}\n  - A: ${answer}`;
  }).join("\n")}`;
}

function learningItemsFromSection(section, kind, title, markdown) {
  const defaults = defaultLearningItems(kind, title, markdown);
  if (!section) return defaults;
  const body = section.replace(/^##\s+.+?\s*\n/, "").trim();
  if (!body) return defaults;

  const lines = body.split(/\r?\n/);
  const items = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const questionMatch = trimmed.match(/^-\s*(?:Q:\s*)?(.+?)\s*$/i);
    const answerMatch = trimmed.match(/^(?:-\s*)?A:\s*(.+?)\s*$/i);
    const indentedAnswerMatch = line.match(/^\s+A:\s*(.+?)\s*$/i);
    if (answerMatch || indentedAnswerMatch) {
      if (!current) current = { question: defaultQuestion(kind, title), answer: "" };
      current.answer = (answerMatch?.[1] || indentedAnswerMatch?.[1] || "").trim();
    } else if (questionMatch) {
      if (current) items.push(current);
      current = { question: questionMatch[1].trim(), answer: "" };
    } else if (current) {
      current.answer = [current.answer, trimmed].filter(Boolean).join(" ");
    }
  }
  if (current) items.push(current);
  const normalized = items.map((item) => ({
    question: item.question,
    answer: item.answer || answerForQuestion(item.question, kind, title, markdown)
  }));
  for (const item of defaults) {
    if (!normalized.some((existing) => normalizeQuestion(existing.question) === normalizeQuestion(item.question))) {
      normalized.push(item);
    }
  }
  return normalized;
}

function questionItemsFromSection(section, title, markdown) {
  if (!section) {
    return [{
      question: `What remains unresolved about "${title}"?`,
      answer: "No specific open question has been recorded yet."
    }];
  }
  const items = parseQuestionAnswerItems(section, "What remains unresolved?");
  if (!items.length) {
    return [{
      question: `What remains unresolved about "${title}"?`,
      answer: "No specific open question has been recorded yet."
    }];
  }
  return items.map((item) => ({
    question: item.question,
    answer: item.answer || openQuestionAnswer(item.question, title, markdown)
  }));
}

function parseQuestionAnswerItems(section, fallbackQuestion) {
  const body = section.replace(/^##\s+.+?\s*\n/, "").trim();
  if (!body || /^-\s*$/.test(body)) return [];
  const lines = body.split(/\r?\n/);
  const items = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const answerMatch = trimmed.match(/^(?:-\s*)?A:\s*(.+?)\s*$/i) || line.match(/^\s+A:\s*(.+?)\s*$/i);
    const qMatch = trimmed.match(/^-\s*(?:Q:\s*)?(.+?)\s*$/i);
    if (answerMatch) {
      if (!current) current = { question: fallbackQuestion, answer: "" };
      current.answer = [current.answer, answerMatch[1].trim()].filter(Boolean).join(" ");
    } else if (qMatch) {
      if (current) items.push(current);
      current = { question: qMatch[1].trim(), answer: "" };
    } else if (current) {
      current.answer = [current.answer, trimmed].filter(Boolean).join(" ");
    }
  }
  if (current) items.push(current);
  return items.filter((item) => item.question || item.answer);
}

function defaultLearningItems(kind, title, markdown) {
  if (kind === "source") {
    return [
      {
        question: `What should I be able to explain from "${title}" without reopening the source?`,
        answer: answerForQuestion("", kind, title, markdown)
      },
      {
        question: `Which examples, definitions, claims, or procedures in "${title}" deserve practice or follow-up notes?`,
        answer: practiceAnswer(title, markdown)
      }
    ];
  }
  return [
    {
      question: `How does "${title}" connect to adjacent domains, real-world systems, or global context?`,
      answer: connectionAnswer(title, markdown)
    },
    {
      question: `What newer, broader, or conflicting source would most improve my understanding of "${title}"?`,
      answer: improvementAnswer(markdown)
    }
  ];
}

function defaultQuestion(kind, title) {
  return kind === "source"
    ? `What should I be able to explain from "${title}" without reopening the source?`
    : `How does "${title}" connect to adjacent domains, real-world systems, or global context?`;
}

function answerForQuestion(question, kind, title, markdown) {
  if (kind === "openQuestion") return openQuestionAnswer(question, title, markdown);
  if (/examples|definitions|claims|procedures|practice|follow-up/i.test(question)) return practiceAnswer(title, markdown);
  if (/newer|broader|conflicting|improve/i.test(question)) return improvementAnswer(markdown);
  if (kind === "open" || /connect|adjacent|global|context|real-world|systems/i.test(question)) return connectionAnswer(title, markdown);
  return sourceAnswer(title, markdown);
}

function openQuestionAnswer(question, title, markdown) {
  if (/merge|split|duplicate|standalone|concept|page|wiki|index|represent|relationship|capture|expand/i.test(question)) {
    return `Current wiki answer: this is a maintenance or modeling decision, not a fact settled by the source. Use the current links, source evidence, and future related sources to decide how "${title}" should be organized.`;
  }
  if (/should|how|what|which|is|are|does|do|can|could|would/i.test(question)) {
    const summary = sectionText(markdown, "Summary");
    if (summary) return `Current source-grounded answer: the page gives a partial basis from its summary, but this question remains open until a source directly resolves it. Summary basis: ${sentence(summary)}`;
  }
  return "Current answer: not resolved yet in the active wiki. Keep this question open until a source directly answers it or a maintenance pass resolves the wiki decision.";
}

function sourceAnswer(title, markdown) {
  const points = sectionBullets(markdown, "Key Points").slice(0, 3).map(cleanSentencePart);
  if (points.length) return `Explain the source through these key points: ${sentence(points.join("; "))}`;
  const summary = sectionText(markdown, "Summary");
  if (summary) return `Start from the source summary: ${sentence(summary)}`;
  return `Use the Summary and Key Points in "${title}" as the answer base, and avoid adding claims that are not supported by the source.`;
}

function practiceAnswer(title, markdown) {
  const points = sectionBullets(markdown, "Key Points").slice(0, 4).map(cleanSentencePart);
  const links = sectionBullets(markdown, "Links").slice(0, 5).map(cleanSentencePart);
  if (links.length) return `Practice by explaining the linked ideas and why they matter here: ${sentence(stripWiki(links.join("; ")))}.`;
  if (points.length) return `Convert these points into recall prompts or examples: ${sentence(points.join("; "))}`;
  return `Turn the named examples, definitions, and claims in "${title}" into short recall prompts and follow-up notes.`;
}

function connectionAnswer(title, markdown) {
  const links = sectionBullets(markdown, "Links").slice(0, 5).map(cleanSentencePart);
  if (links.length) return `The current source-backed connections are: ${sentence(stripWiki(links.join("; ")))}. Broader links should be added when later sources support them.`;
  const questions = sectionBullets(markdown, "Open Questions").slice(0, 2).map(cleanSentencePart);
  if (questions.length) return `Use the open questions as the next bridge outward: ${sentence(questions.join("; "))}`;
  return `"${title}" should be connected outward through future sources, examples, systems, and real-world cases only when the wiki has evidence for those links.`;
}

function improvementAnswer(markdown) {
  const contradictions = sectionBullets(markdown, "Contradictions").filter((item) => !/^none yet\.?$/i.test(item)).slice(0, 2).map(cleanSentencePart);
  if (contradictions.length) return `Prioritize sources that clarify these tensions: ${sentence(contradictions.join("; "))}`;
  const questions = sectionBullets(markdown, "Open Questions").slice(0, 2).map(cleanSentencePart);
  if (questions.length) return `Look for sources that answer or challenge these unresolved questions: ${sentence(questions.join("; "))}`;
  return "A newer, broader, or conflicting source would improve the wiki by testing the current synthesis and either confirming, refining, or contradicting it.";
}

function sectionText(markdown, heading) {
  return extractSection(markdown, heading)
    .replace(/^##\s+.+?\s*\n/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionBullets(markdown, heading) {
  return extractSection(markdown, heading)
    .replace(/^##\s+.+?\s*\n/, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*/, "").trim())
    .filter((line) => !/^A:\s*/i.test(line))
    .map((line) => line.replace(/^Q:\s*/i, "").trim())
    .filter(Boolean);
}

function stripWiki(value) {
  return String(value)
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1");
}

function sentence(value) {
  const text = cleanSentencePart(value);
  if (!text) return "";
  return text.length > 360 ? `${text.slice(0, 357).trim()}...` : `${text}.`;
}

function cleanSentencePart(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\s*([.;:!?])\s*;/g, ";")
    .replace(/[.。]+$/g, "")
    .trim();
}

function cleanAnswer(value) {
  return String(value)
    .replace(/;\s+/g, "; ")
    .replace(/\.\.;/g, ";")
    .replace(/\.;/g, ";")
    .replace(/\.{2,}/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestion(value) {
  return String(value).toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
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
