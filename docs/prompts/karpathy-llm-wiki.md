# LLM Wiki Prompt

Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

Credit: Andrej Karpathy, `karpathy/llm-wiki.md`.

This project is an implementation of the LLM Wiki pattern described in the linked gist. The app also creates vault-level `AGENTS.md` files that instantiate the pattern for Codex-style agents.

## Operational Summary

An LLM Wiki is a persistent, compounding personal knowledge base maintained by an LLM. Instead of only retrieving raw documents at query time, the agent incrementally builds a structured markdown wiki between the user and the raw sources.

The pattern has three layers:

- `raw/`: immutable user-supplied source files.
- `wiki/`: LLM-maintained markdown summaries, source pages, concept pages, entity pages, area pages, and synthesis pages.
- `AGENTS.md`: schema and operating rules that tell the LLM how to maintain the wiki.

Core operations:

- Ingest new raw sources one at a time or in batches.
- Query the wiki and cite stored wiki/source pages.
- File valuable answers back into the wiki as new raw sources.
- Lint the wiki for stale claims, contradictions, orphan pages, and missing cross-references.
- Maintain `index.md` as the content catalog and `log.md` as the chronological record.

The human curates sources, asks questions, and directs investigation. The LLM handles summarizing, filing, cross-referencing, bookkeeping, and consistency maintenance.

For the full original idea text, read the linked gist.
