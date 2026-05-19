import fs from "node:fs";
import path from "node:path";
import { createProvider } from "./provider.mjs";
import { listVaults, listWikiFiles, readIfExists, vaultName } from "./vaults.mjs";

export async function answerQuestion(question, config, provider = createProvider(config)) {
  const vaults = listVaults(config.vaultsRoot);
  const indexes = vaults.map((vault) => ({
    vault,
    name: vaultName(vault),
    index: readIfExists(path.join(vault, "index.md"))
  }));

  const selected = selectRelevantFiles(question, vaults, config.chatMaxFiles);
  const context = selected.map((file) => {
    const vault = vaults.find((candidate) => file.startsWith(candidate));
    return `# ${vaultName(vault)} / ${path.relative(vault, file)}\n\n${stripUserNotes(fs.readFileSync(file, "utf8"))}`;
  }).join("\n\n---\n\n");

  const prompt = `Answer the user's question using the Obsidian LLM Wiki vaults.

Rules:
- Prefer cited wiki links and source page references.
- Say when the vaults do not contain enough information.
- Do not invent facts beyond the provided context.

Vault indexes:
${indexes.map((item) => `## ${item.name}\n${item.index}`).join("\n\n")}

Selected context:
${context}

Question:
${question}`;

  return provider.complete([
    { role: "system", content: "You answer questions from local Obsidian wiki vaults with careful source traceability." },
    { role: "user", content: prompt }
  ]);
}

function selectRelevantFiles(question, vaults, limit) {
  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const scored = [];
  for (const vault of vaults) {
    for (const file of listWikiFiles(vault)) {
      const rel = path.relative(vault, file).toLowerCase();
      const text = stripUserNotes(fs.readFileSync(file, "utf8")).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (rel.includes(term)) score += 5;
        const matches = text.match(new RegExp(escapeRegExp(term), "g"));
        if (matches) score += Math.min(matches.length, 10);
      }
      if (score > 0) scored.push({ file, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.file);
}

function stripUserNotes(markdown) {
  return String(markdown).replace(/\n## User Notes[\s\S]*$/m, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
