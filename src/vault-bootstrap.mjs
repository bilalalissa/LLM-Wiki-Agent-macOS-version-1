import fs from "node:fs";
import path from "node:path";
import { today } from "./vaults.mjs";

export function bootstrapVault(vaultPath) {
  const created = [];
  for (const dir of [
    "raw/inbox",
    "raw/input",
    "raw/processed",
    "raw/processed/archive",
    "raw/assets",
    "wiki/sources",
    "wiki/entities",
    "wiki/concepts",
    "wiki/projects",
    "wiki/areas",
    "wiki/questions",
    "wiki/synthesis",
    "wiki/maps",
    "wiki/archive",
    "templates"
  ]) {
    const full = path.join(vaultPath, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      created.push(dir);
    }
  }
  ensureFile(vaultPath, "AGENTS.md", agentsTemplate(), created);
  ensureFile(vaultPath, "CLAUDE.md", "See [[AGENTS]] for the LLM Wiki operating schema.\n", created);
  ensureFile(vaultPath, "index.md", indexTemplate(), created);
  ensureFile(vaultPath, "log.md", logTemplate(), created);
  return created;
}

function ensureFile(vaultPath, rel, content, created) {
  const full = path.join(vaultPath, rel);
  if (fs.existsSync(full)) return;
  fs.writeFileSync(full, content);
  created.push(rel);
}

function indexTemplate() {
  return `# Index

| Page | Type | Summary | Updated |
|---|---|---|---|
`;
}

function logTemplate() {
  return `# Log

## [${today()}] schema | Initialize LLM Wiki vault

Changed:
- Created required LLM Wiki folders and scaffold files.

Sources:
- none

Notes:
- Generated automatically by LLM Wiki Agent.

Next:
- Add markdown or text sources to \`raw/inbox/\` or \`raw/input/\`.
`;
}

function agentsTemplate() {
  return `# LLM Wiki Agent Schema

This vault is an LLM-maintained second brain. The human curates sources, asks questions, and directs emphasis. The agent maintains the wiki.

## Prime Directive

Every interaction with this vault follows this schema unless the human explicitly says otherwise.

The agent must:

- Treat \`raw/\` as immutable source material.
- Treat \`wiki/\` as the agent-owned synthesis layer.
- Read \`index.md\` before answering wiki questions or changing wiki pages.
- Append every ingest, query, lint pass, and structural change to \`log.md\`.
- Keep pages interlinked with Obsidian wiki links.
- Preserve source traceability for factual claims.
- Flag contradictions instead of silently resolving them.
- Prefer small, coherent page updates over chat-only answers.

## Directory Contract

\`\`\`text
raw/
  inbox/        New sources waiting to be ingested.
  input/        Agent-saved chat answers waiting to be ingested.
  processed/    Sources already ingested. Preserve original content.
  assets/       Local images, PDFs, audio, screenshots, and downloaded attachments.

wiki/
  sources/      One summary page per ingested source.
  entities/     People, organizations, products, places, tools, named systems.
  concepts/     Ideas, models, patterns, claims, terms, principles.
  projects/     Active outcomes, efforts, builds, investigations, or initiatives.
  areas/        Ongoing life or work domains with no fixed endpoint.
  questions/    Durable questions, analyses, comparisons, and answers worth saving.
  synthesis/    Higher-level summaries, thesis pages, maps of meaning, state of knowledge.
  maps/         Navigation pages and topic hubs.
  archive/      Retired or superseded wiki pages.

templates/      Reusable page templates.
index.md        Content-oriented catalog of the wiki.
log.md          Append-only chronological maintenance record.
AGENTS.md       This schema.
CLAUDE.md       Claude-compatible pointer to this schema.
\`\`\`

## Page Standards

Every generated wiki page should include YAML frontmatter with \`type\`, \`status\`, \`created\`, \`updated\`, \`sources\`, and \`tags\`.

Use source-backed claims and Obsidian wiki links. Never present an inference as a source fact.

## Ingest Workflow

1. Read the raw source.
2. Create one source summary page in \`wiki/sources/\`.
3. Update or create affected concept/entity/area/question/synthesis pages.
4. Move the source to \`raw/processed/\`.
5. Update \`index.md\`.
6. Append an ingest entry to \`log.md\`.

## Query Workflow

1. Read \`index.md\`.
2. Search relevant \`wiki/\` pages.
3. Answer with wiki links and source-backed citations.
4. File durable answers back into the wiki when useful.
5. Append a query entry to \`log.md\`.
`;
}
