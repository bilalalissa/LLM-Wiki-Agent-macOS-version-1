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
    "raw/assets/archive",
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
  ensureAgentsMediaRules(vaultPath, created);
  ensureAgentsLearningRules(vaultPath, created);
  ensureFile(vaultPath, "CLAUDE.md", "See [[AGENTS]] for the LLM Wiki operating schema.\n", created);
  ensureFile(vaultPath, "index.md", indexTemplate(), created);
  ensureFile(vaultPath, "log.md", logTemplate(), created);
  return created;
}

function ensureAgentsLearningRules(vaultPath, created) {
  const file = path.join(vaultPath, "AGENTS.md");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("## Learning Sections")) return;
  fs.writeFileSync(file, `${text.trim()}\n\n${learningSectionsTemplate()}\n`);
  created.push("AGENTS.md learning rules");
}

function ensureAgentsMediaRules(vaultPath, created) {
  const file = path.join(vaultPath, "AGENTS.md");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("## Media Ingest Rules")) return;
  fs.writeFileSync(file, `${text.trim()}\n\n${mediaRulesTemplate()}\n`);
  created.push("AGENTS.md media rules");
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
  assets/       Processed local images, PDFs, audio, screenshots, video, and downloaded attachments.

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

${learningSectionsTemplate()}

## Ingest Workflow

1. Read the raw source.
2. Create one source summary page in \`wiki/sources/\`.
3. Update or create affected concept/entity/area/question/synthesis pages.
4. Move text sources to \`raw/processed/\` and media sources to \`raw/assets/\`.
5. Update \`index.md\`.
6. Append an ingest entry to \`log.md\`.

## Media Ingest Rules

${mediaRulesTemplate().replace("## Media Ingest Rules\n\n", "")}

## Query Workflow

1. Read \`index.md\`.
2. Search relevant \`wiki/\` pages.
3. Answer with wiki links and source-backed citations.
4. File durable answers back into the wiki when useful.
5. Append a query entry to \`log.md\`.
`;
}

function learningSectionsTemplate() {
  return `## Learning Sections

Generated source pages and generated linked wiki pages should include these structural sections when useful:

- \`Open Questions\`: unresolved source or wiki maintenance questions.
- \`Contradictions\`: source conflicts, tension, or "None yet."
- \`Source's Related Learning Questions\`: source-grounded questions that help the user practice, connect, and retain the material.
- \`Open Learning Questions\`: broader questions that expand knowledge, transfer, and global awareness beyond the source.

Learning questions must be phrased as questions, not claims. They should help the user discover adjacent domains, real-world implications, history, geography, ethics, systems, or cross-topic links without inventing facts.`;
}

function mediaRulesTemplate() {
  return `## Media Ingest Rules

When a new source in \`raw/\`, \`raw/inbox/\`, or \`raw/input/\` is an image, PDF, audio file, video, screenshot, or other local media:

1. Move the media file to \`raw/assets/\` unless it is already there.
2. Create a source page in \`wiki/sources/\` with \`type: source\`, \`media_kind\`, \`source_path\`, and media tags.
3. Ask the configured provider to inspect/analyze the local media in read-only mode when possible.
4. Embed images directly in the source page with an Obsidian embed and link every media type back to its local asset.
5. Add any reliable visual/audio observations only when the agent has actually inspected the media or the human supplied a description.
6. Link the media source page to relevant concepts, entities, areas, questions, or project pages when the content is known.
7. Never discard media. Archive retired media under \`raw/assets/archive/\`.`;
}
