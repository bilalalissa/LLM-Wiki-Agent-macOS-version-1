# LLM Wiki Agent Checklist

## Completed

- [x] Add `.env` with default provider/model and API key placeholders.
- [x] Add provider adapter for OpenAI, Anthropic, and OpenAI-compatible APIs.
- [x] Discover vaults by `*-vault` folder plus `AGENTS.md`.
- [x] Detect raw markdown/text files outside `raw/processed/` and `raw/assets/`.
- [x] Ingest raw files into source summaries and concept pages.
- [x] Update `index.md` and `log.md` during ingestion.
- [x] Move ingested files into `raw/processed/`.
- [x] Add polling watcher for new raw files.
- [x] Add browser chat interface for vault questions.
- [x] Add full README user guide.
- [x] Add Help button in the UI that renders the README.
- [x] Add Files tab showing received and processed files with local timestamps.
- [x] Run auto-ingest from the local UI server.
- [x] Add fixed scrollable topic list in the UI margin.
- [x] Add full Topics tab with paths.
- [x] Render chat answers as formatted HTML instead of raw markdown.
- [x] Tune Help page code block colors.
- [x] Add Local tab that answers from stored wiki pages without AI or internet.
- [x] Add whole-UI theme switcher.
- [x] Add copy formats for result boxes: pure text, formatted text, and markdown.
- [x] Add selection toolbar with highlight, copy, and add-note actions.
- [x] Persist user notes into markdown files and manage them in the UI.
- [x] Show saved-note indicators and highlights inside result boxes.
- [x] Use the selection toolbar Highlight action to toggle UI highlights.
- [x] Archive processed sources from the Files tab instead of permanently deleting them.
- [x] Add an Archive tab with archived item listing and permanent delete for selected archived files.
- [x] Add Archive tab relation labels and restore for selected archived files.
- [x] Add Chat tab save-to-raw-source action for turning Q&A into ingestable markdown.
- [x] Add provider auth-method config, Gemini provider support, and documented OAuth limitations.
- [x] Add sidebar topic search and source-first topic content preview.
- [x] Add OpenAI subscription mode backed by local Codex CLI login.
- [x] Add Provider tab with safe non-secret provider config/status details.
- [x] Fix note save refresh and add note hover display mode toggle.

## Next Hardening

- [ ] Add a review mode before writing wiki changes.
- [ ] Add better duplicate concept detection.
- [ ] Add entity and area page creation during automatic ingest.
- [ ] Add tests with a mock AI provider.
- [ ] Add per-vault provider/model overrides.
- [ ] Add richer retrieval for chat once the wiki grows.
- [ ] Add a launch agent or shell script to run the watcher at login.
