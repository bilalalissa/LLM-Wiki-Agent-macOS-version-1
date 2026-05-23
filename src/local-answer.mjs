import fs from "node:fs";
import path from "node:path";
import { listVaults, listWikiFiles, vaultName } from "./vaults.mjs";

export function answerLocally(question, config, options = {}) {
  const terms = tokenize(question);
  if (!terms.length) {
    return "Ask a question or enter a few topic words. Local mode searches only the stored wiki pages and does not call an AI provider.";
  }

  const matches = findMatches(terms, config, options);
  if (!matches.length) {
    return [
      "No strong local match found in the stored wiki pages.",
      "",
      "Try using a topic name from the right-side list, or ingest more sources into the relevant vault."
    ].join("\n");
  }

  const top = matches.slice(0, 6);
  const lines = [
    `Local answer from ${top.length} stored wiki page${top.length === 1 ? "" : "s"}:`,
    ""
  ];

  for (const match of top) {
    lines.push(`## ${match.title}`);
    lines.push(`${match.vault} / ${match.relativePath}`);
    lines.push("");
    for (const snippet of match.snippets) {
      lines.push(`- ${snippet}`);
    }
    lines.push("");
  }

  lines.push("This answer was generated locally from stored wiki text only. No AI provider or internet connection was used.");
  return lines.join("\n");
}

function findMatches(terms, config, options) {
  const matches = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    for (const file of listWikiFiles(vaultPath)) {
      const relativePath = path.relative(vaultPath, file);
      if (!relativePath.startsWith(`wiki${path.sep}`)) continue;
      const text = filterStructuralSections(stripUserNotes(fs.readFileSync(file, "utf8")), options);
      const score = scoreText(`${relativePath}\n${text}`, terms);
      if (score <= 0) continue;
      matches.push({
        vault: vaultName(vaultPath),
        relativePath,
        title: extractTitle(text, relativePath),
        score,
        snippets: extractSnippets(text, terms)
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

function scoreText(text, terms) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const matches = lower.match(new RegExp(escapeRegExp(term), "g"));
    if (matches) score += Math.min(matches.length, 20);
  }
  return score;
}

function extractSnippets(markdown, terms) {
  const sections = markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\n(?=##?\s+)/)
    .map((section) => clean(section))
    .filter(Boolean);

  const ranked = sections
    .map((section) => ({ section, score: scoreText(section, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => firstUsefulSentence(item.section));

  if (ranked.length) return ranked;

  const summary = sections.find((section) => /^summary\b/i.test(section.replace(/^#+\s*/, "")));
  return [firstUsefulSentence(summary || clean(markdown))].filter(Boolean);
}

function firstUsefulSentence(text) {
  const cleaned = clean(text).replace(/^#+\s*/, "");
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter((item) => item.length > 20);
  return (sentences[0] || cleaned).slice(0, 420);
}

function extractTitle(markdown, relativePath) {
  const title = markdown.match(/^#\s+(.+)$/m);
  if (title) return stripMarkdown(title[1]);
  return path.basename(relativePath, path.extname(relativePath))
    .replace(/^\d{4}-\d{2}-\d{2}--/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clean(markdown) {
  return stripMarkdown(stripUserNotes(markdown))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("type:") && !line.startsWith("status:") && !line.startsWith("created:") && !line.startsWith("updated:") && !line.startsWith("tags:") && !line.startsWith("sources:"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripUserNotes(markdown) {
  return String(markdown).replace(/\n## User Notes[\s\S]*$/m, "");
}

function filterStructuralSections(markdown, options = {}) {
  const hidden = new Set(Array.isArray(options.hiddenSections) ? options.hiddenSections : []);
  if (!hidden.size) return markdown;
  const sectionMap = {
    openQuestions: "Open Questions",
    contradictions: "Contradictions",
    sourceLearningQuestions: "Source's Related Learning Questions",
    openLearningQuestions: "Open Learning Questions"
  };
  let result = markdown;
  for (const key of hidden) {
    const heading = sectionMap[key];
    if (heading) result = removeSection(result, heading);
  }
  return result;
}

function removeSection(markdown, heading) {
  const pattern = new RegExp(`\\n##\\s+${escapeRegExp(heading)}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`);
  return markdown.replace(pattern, "");
}

function stripMarkdown(value) {
  return String(value)
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^- /gm, "");
}

function tokenize(question) {
  const stop = new Set(["what", "with", "from", "that", "this", "about", "tell", "show", "give", "does", "have", "there", "into", "your", "wiki", "vault"]);
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !stop.has(term));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
