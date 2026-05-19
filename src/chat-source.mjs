import fs from "node:fs";
import path from "node:path";
import { ensureDir, listVaults, slugify, vaultName } from "./vaults.mjs";

export function saveChatAsRawSource(config, payload) {
  const vaultPath = resolveVault(config, payload.vault);
  const question = String(payload.question || "").trim();
  const answer = String(payload.answer || "").trim();
  if (!question) throw new Error("Question is empty.");
  if (!answer || answer === "Ready.") throw new Error("Answer is empty.");

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const title = `Chat insight - ${question.slice(0, 72)}`;
  const fileName = `${stamp}--chat--${slugify(question)}.md`;
  const rel = path.join("raw", "input", fileName);
  const fullPath = uniquePath(path.join(vaultPath, rel));
  ensureDir(path.dirname(fullPath));
  fs.writeFileSync(fullPath, renderSource({ title, question, answer, now }));

  return {
    vault: vaultName(vaultPath),
    file: path.relative(vaultPath, fullPath).replace(/\\/g, "/")
  };
}

function renderSource({ title, question, answer, now }) {
  return `---
type: chat-capture
created: ${now.toISOString()}
source: agent-ui-chat
---

# ${title}

## Question

${question}

## Answer

${answer}
`;
}

function resolveVault(config, name) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === name);
  if (!vaultPath) throw new Error(`Unknown vault: ${name}`);
  return vaultPath;
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
