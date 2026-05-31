<a id="top"></a>

# LLM Wiki Agent

<p align="center">
  <img src="media/Wiki-Agent.png" alt="Wiki Agent Screenshot" width="900">
</p>

## Demo Videos

### Graph View Demo 1

[Watch Graph View Demo 1](media/Graph-view-1.mov)

### Graph View Demo 2

[Watch Graph View Demo 2](media/Graph-view-2.mov)

LLM Wiki Agent is a local-first macOS app that turns Obsidian vaults into an LLM-maintained second brain. You add raw sources, ask questions, and browse in Obsidian; the app maintains the markdown wiki layer: summaries, concepts, source links, indexes, logs, archives, and notes.

An LLM is a large language model: software that can read, summarize, compare, and synthesize text. The point of an LLM Wiki is to make that work persistent. Instead of asking an LLM to rediscover the same documents every time, the agent incrementally builds a durable wiki that compounds as you add sources and ask questions.

This project implements the LLM Wiki pattern described by Andrej Karpathy: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## Table Of Contents

- [What This App Does](#what-this-app-does)
- [Requirements](#requirements)
- [Clone And Install](#clone-and-install)
- [First Run Setup](#first-run-setup)
- [Vault Setup](#vault-setup)
- [Automatic Vault Bootstrap](#automatic-vault-bootstrap)
- [AI Provider Setup](#ai-provider-setup)
- [Shared Agent State And iPhone/iPad Bridge](#shared-agent-state-and-iphoneipad-bridge)
- [Arc Browser Companion Extension](#arc-browser-companion-extension)
- [How To Use The App](#how-to-use-the-app)
- [Native macOS Features](#native-macos-features)
- [Local `.env` And `.gitignore`](#local-env-and-gitignore)
- [Clean GitHub Upload](#clean-github-upload)
- [Credits](#credits)

## What This App Does

- Watches configured Obsidian vault raw folders.
- Automatically creates required LLM Wiki files in detected vaults.
- Ingests markdown/text sources into `wiki/` pages and preserves media sources as local vault assets.
- Adds learning-analysis sections to processed pages so source knowledge turns into practice questions and broader follow-up questions.
- Maintains `index.md` and `log.md`.
- Provides Chat, Local Search, Files, Archive, Topics, Provider, and Notes tabs.
- Provides a right-side topic explorer that filters by title, tag, wiki element, and updated date.
- Lets useful chat answers be saved back as raw sources.
- Supports source rename, merge, archive/restore, and permanent archive deletion.
- Stores user notes inside related markdown files and shows note indicators in results.
- Supports note links, file attachments, pasted clipboard images, note hover previews, and rendered note media.
- Supports Local result display modes: tree plus accordion, accordion, and plain markdown.
- Keeps tab navigation and key tab controls sticky while scrolling.
- Provides a Snap focus overlay for magnified reading of selected result text.
- Includes multiple UI themes, including Light, Dark, Sepia, Forest, Contrast, and Megatron.
- Runs as a native macOS app with a menu bar icon and a local webview UI.
- Shares non-secret vault settings through `.llm-wiki/settings.json` so macOS, iPad, iPhone, and future agents display the same agent state.
- Exposes optional Mac Bridge endpoints for iPhone/iPad clients using subscription-backed Codex CLI AI.
- Includes an Arc/Chromium browser companion extension for clipping selected text, media, links, or whole pages into a selected vault.

[Back to top](#top)

## Requirements

- macOS 13 or later.
- Node.js 18 or later.
- Obsidian installed: https://obsidian.md
- Obsidian Web Clipper installed: https://obsidian.md/clipper
- At least one Obsidian vault configured.
- At least one AI provider configured, or Codex CLI logged in for ChatGPT subscription mode.

[Back to top](#top)

## Clone And Install

```bash
git clone https://github.com/bilalalissa/LLM-Wiki-Agent-macOS-version-1.git
cd LLM-Wiki-Agent-macOS-version-1
./scripts/build_macos_app.sh
./scripts/install_macos_app.sh
open "/Applications/LLM Wiki Agent.app"
```

The installed app copies a clean default config to:

```text
~/Library/Application Support/LLM Wiki Agent/config.env
```

Edit that file from the app menu:

```text
menu bar icon -> Open Config
```

`Open Config` opens the app config in TextEdit directly, so macOS does not ask you to choose an application for `config.env`.

[Back to top](#top)

## First Run Setup

Every time the app starts, it checks:

- Obsidian is installed.
- Obsidian Web Clipper appears to be installed.
- At least one Obsidian vault is available, either registered in Obsidian or under `VAULTS_ROOT`.
- At least one AI provider is configured.

If anything is missing, the app shows setup feedback with instructions.

[Back to top](#top)

## Vault Setup

The app detects vaults registered in Obsidian automatically, including cloud vaults added later through Obsidian. `VAULTS_ROOT` is still useful as a fallback or when you keep several vaults under one dedicated folder.

Example:

```text
VAULTS_ROOT=/Users/you/Documents/Obsidian-Vaults
```

Good practice: start with one dedicated LLM Wiki vault. After the workflow is comfortable, add more vaults if you want separate domains.

Example vault names:

```text
Research-vault/
Personal-vault/
Course-notes-vault/
```

The app can detect normal Obsidian vaults through Obsidian's local vault registry, through their `.obsidian/` folder under `VAULTS_ROOT`, and through folders ending in `-vault`. If you add a new iCloud vault to Obsidian, the agent picks it up from Obsidian's registry on the next refresh/startup cycle.

The Chat tab's `Save to` vault list refreshes from the same detected vault list, so newly added Obsidian vaults become available without restarting the app window.

[Back to top](#top)

## Automatic Vault Bootstrap

When the app detects a vault, it automatically creates missing LLM Wiki requirements:

```text
AGENTS.md
CLAUDE.md
index.md
log.md
raw/inbox/
raw/input/
raw/processed/
raw/assets/
raw/assets/archive/
wiki/sources/
wiki/entities/
wiki/concepts/
wiki/projects/
wiki/areas/
wiki/questions/
wiki/synthesis/
wiki/maps/
wiki/archive/
templates/
```

`AGENTS.md` contains the operating schema for Codex-style agents. `CLAUDE.md` points Claude-style tools to the same schema.

[Back to top](#top)

## AI Provider Setup

Supported modes:

- `openai_subscription`: uses local Codex CLI login through `codex exec`.
- `openai`: direct OpenAI API key.
- `anthropic`: direct Anthropic API key.
- `openai_compat`: OpenAI-compatible local or hosted APIs.
- `gemini`: Gemini API key or OAuth bearer token.

For ChatGPT subscription mode:

```bash
codex login
codex login status
```

Then configure:

```text
DEFAULT_AI_PROVIDER=openai_subscription
DEFAULT_AI_MODEL=gpt-5.4
OPENAI_AUTH_METHOD=subscription
OPENAI_SUBSCRIPTION_CLIENT=codex
OPENAI_CODEX_COMMAND=codex
```

Direct OpenAI and Anthropic APIs require API credentials and separate API billing.

[Back to top](#top)

## Shared Agent State And iPhone/iPad Bridge

Every bootstrapped vault includes:

```text
.llm-wiki/settings.json
```

This manifest is shared by all agents and stores only non-secret settings: provider mode, transport label, default model, ingest/search preferences, display preferences, enabled wiki sections, and last-known agent metadata. API keys, OAuth tokens, Codex login state, bridge tokens, and local absolute paths stay in local app config or Keychain.

The macOS app also acts as the Mac Bridge for iPhone/iPad clients. By default it listens only on this Mac:

```text
MAC_BRIDGE_HOST=127.0.0.1
CHAT_PORT=8789
MAC_BRIDGE_TOKEN=
```

To let an iPhone or iPad on the same local network connect, set:

```text
MAC_BRIDGE_HOST=0.0.0.0
MAC_BRIDGE_TOKEN=choose-a-long-random-token
```

Then use this URL in the iPhone/iPad app's shared settings:

```text
http://<your-mac-local-ip>:8789
```

Store the same bridge token in the iPhone/iPad app's Settings screen. The token is kept in iOS Keychain and is not written into `.llm-wiki/settings.json`.

Bridge endpoints:

- `GET /api/vaults`
- `GET /api/shared-settings`
- `POST /api/shared-settings`
- `GET /api/provider-status`
- `POST /api/complete`

[Back to top](#top)

## Arc Browser Companion Extension

The project includes an unpacked Arc/Chromium extension:

```text
extension/arc-clipper/
```

It lets you export browser content into a selected Obsidian vault through the running local agent.

Supported clip types:

- selected browser text
- current whole page text and captured HTML
- page media references
- downloaded page media when browser or server access permits it
- single YouTube page-video downloads with subtitle transcript extraction when `yt-dlp` is installed
- right-clicked image, audio, video, media link, or normal link

Install in Arc:

1. Start `LLM Wiki Agent.app`.
2. Open `arc://extensions`.
3. Enable Developer Mode.
4. Click `Load unpacked`.
5. Select `extension/arc-clipper`.
6. Click the extension icon, confirm the Agent URL, and choose a vault.

After updating files in this repo, open `arc://extensions` and click Reload on the unpacked `LLM Wiki Agent Clipper` extension so Arc uses the latest background script.

For YouTube page media clips, install `yt-dlp` on the Mac that runs the agent:

```bash
brew install yt-dlp
```

If `yt-dlp` is installed somewhere outside `PATH`, launch the app with `YT_DLP_PATH=/path/to/yt-dlp`. The agent uses it to download one merged video file and available Arabic/English subtitles. YouTube extraction also needs a JavaScript runtime; the app automatically passes the current Node runtime to `yt-dlp` when available, or you can set `YT_DLP_JS_RUNTIME=/path/to/node`. Disable external video downloading with `LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD=1`.

Default Agent URL:

```text
http://127.0.0.1:8789
```

Clips are saved into the selected vault as new raw sources:

```text
raw/input/
```

When browser permissions allow media export, binary media is downloaded and saved into:

```text
raw/assets/browser-clips/
```

The extension watches visible media elements, resource timing entries, browser media requests, and readable stream manifests so images, PDFs, audio, video, and common streaming URLs are detected. For readable HLS/DASH manifests, it inspects the source manifest and records a single clipped markdown source with manifest metadata. It does not upload manifest chunks to the local agent and does not save stream chunks into Obsidian vault assets. The app's normal auto-ingest then processes the new raw source and updates the wiki.

The extension popup prepares clips before submission. It shows a progress bar, detected media details, how many media items were downloaded, and which items are URL-only. Arc/Chromium popups close automatically when focus moves away; if that happens, the extension keeps the clip state in the background and shows a toolbar badge while work continues. Reopen the extension icon to restore the progress, ready review screen, or saved/error result. Before submitting, review the title and enter optional comma-separated tags such as `meeting, research, ai/agents`. The app writes those tags into the saved Markdown frontmatter and source summary. Click `Submit to vault` only after reviewing the prepared clip.

For video pages, start playback only long enough for the page to expose its media manifest URL, then click `Prepare page media`. The extension inspects detected HLS/DASH manifests (`.m3u8` and `.mpd`) directly from the source, counts listed segment/chunk URLs, and sends one clipped content item to the agent. It does not wait for playback to finish, does not poll until chunks finish loading, and does not upload chunk files. If a site does not expose a readable manifest, hidden chunks cannot be requested directly; the generated source keeps any already-visible media URLs for traceability.

For YouTube watch and Shorts pages, `Prepare page media` is stricter: the extension sends no detected `videoplayback` chunks, storyboard images, thumbnails, or sub-videos. It sends one page-video request to the local agent. The agent then saves one merged video under `raw/assets/browser-clips/` and writes available subtitle text into the generated raw source so the wiki can ingest and reason over the clip. Use this only for videos you have the right to archive.

Before a YouTube page-video clip is submitted, the extension asks the local agent to estimate the selected single-video file size. If the estimate is above the raw-vault safety limit, the popup warns you and defaults to `Save transcript only`. You can instead choose `Download temporary copy outside raw/`, which stores the video under `~/Downloads/LLM Wiki Agent Temporary Clips/`, or explicitly choose `Save video into vault raw assets` when you want the large file archived in the vault.

[Back to top](#top)

## How To Use The App

1. Put markdown, text, image, PDF, audio, or video sources into a vault's `raw/inbox/` folder.
2. Keep the app running. It auto-detects and ingests sources.
3. Browse generated pages in Obsidian under `wiki/`.
4. Use Chat for AI-assisted questions.
5. Use Local for offline wiki search.
6. Use Topics to inspect all indexed pages.
7. Use Files and Archive to manage processed sources.
8. Use Notes to manage notes attached to result text.
9. Use Provider to inspect safe provider status without exposing secrets.

Useful chat answers can be saved back into `raw/input/` and ingested like any other source.

Local result display options:

- `Tree + accordion` groups results by vault and wiki element, then lets each result expand or collapse.
- `Accordion` shows a flatter list of expandable results.
- `Plain` shows the original rendered markdown answer.
- `Start` controls whether results begin collapsed, expanded, or with only the first result expanded.
- Rendered answers use automatic text direction for mixed Arabic/English content. Each Local accordion result also has `Auto`, `RTL`, and `LTR` controls for manual direction alignment.

The Local display preference is saved on the device.

Main app layout:

- Tab titles stay fixed at the top while scrolling.
- Local, Files, Archive, and Notes controls are grouped into a single sticky controls bar.
- Controls are compact so result content has more reading space.

Focused reading:

- The tab row stays fixed while scrolling.
- Active tab controls stay near the top in compact form.
- Select result text and click `Snap` to dim the screen and show the selected text in a magnified focus box.
- Use the Snap size slider to control magnification. The size preference is saved on the device.
- In the macOS app, Snap uses a native overlay; in browser fallback mode, it dims the app page.

Adding notes from Chat or Local results:

- Select text in a result box and click `Add note`.
- Paste plain text or markdown directly into the note box.
- Use `Add link` to insert a markdown link.
- Use `Add media` to attach an image, PDF, audio file, or video file. The app saves the file under `raw/assets/user-notes/` in the related vault and inserts an Obsidian embed/link into the note.
- Paste a copied image directly into the note box with `Cmd+V`; the app saves it as note media and inserts the Obsidian embed.
- Saved notes are written into the related markdown file under `## User Notes`, so they remain visible in Obsidian and in the app.
- Hover note indicators to preview note text and attached media; click an indicator to jump to the note card in the Notes tab.

Processed source language:

- The agent detects each source's primary language.
- Generated source-page content is written in that source language where possible.
- Stable schema headings stay consistent so the app can parse sections reliably.

The Files tab can rename processed sources:

- Select exactly one source.
- Click `Rename selected source`.
- Enter the new title.
- The app renames the raw source file and source page when present, updates `source_path`, updates wiki links/references, refreshes the index mapping, and appends a maintenance log entry.

Files, Archive, and Topics tables support local filtering and sorting:

- Use the search box to filter visible rows.
- Use dropdowns to filter by vault, status, type, or archive kind where available.
- Click sortable column headers to toggle ascending or descending order.
- In Files and Archive, click a row or checkbox to toggle it, `Shift`+click or `Shift`+Arrow to select a visible range, `Cmd`+click to toggle non-adjacent rows, `Cmd`+Arrow to jump focus to an edge row, and `Cmd`+A to select all visible rows.

The Files tab can merge processed sources:

- Select two or more sources from the same vault.
- Click `Merge selected sources`.
- Enter a title for the merged source.
- Choose whether to keep originals active or archive them after the merge.

The merged source is written to `raw/input/` as a new markdown file, so auto-ingest processes it like any other source. If originals are archived, the app uses the normal archive workflow: raw/source pages are moved to archive folders and active wiki/index references are cleaned up.

Media ingest works as follows:

- Images, PDFs, audio, and video dropped into `raw/` or `raw/inbox/` are moved to `raw/assets/`.
- The app creates a traceable source page in `wiki/sources/`.
- Image source pages include an Obsidian embed plus a local asset link.
- Media facts are not invented. Add a description or ask the agent to inspect media before relying on observations.

Processed wiki pages include structural analysis sections:

- `Open Questions` for unresolved source or maintenance questions with current answers or explicit unresolved status.
- `Contradictions` for conflicts, tension, or explicit "None yet" status.
- `Source's Related Learning Questions` for source-grounded practice and retention questions with answers.
- `Open Learning Questions` for broader connections, transfer, and global-awareness follow-up with answers.

On source pages, the two learning-question sections are placed immediately after `Key Points`. Each item is stored as `Q:` with an indented `A:` answer so the wiki captures both the question and the current source-grounded answer.

The right-side Topics & Insights panel supports:

- free-text search over title, summary, tags, dates, vault, path, and wiki element
- wiki element filtering, such as source, concept, area, question, or synthesis
- tag filtering
- updated-date range filtering

[Back to top](#top)

## Native macOS Features

The native macOS wrapper provides:

- A normal app window.
- A small macOS menu bar icon.
- `Show App` from the menu bar.
- `Open Config`.
- `Open Vaults Folder`.
- `Start at Login` toggle.
- `Show Dock Icon` toggle.
- `Close Button Keeps Running` toggle.
- `Hide Setup Required on Startup` toggle.
- Startup setup checks.

`Close Button Keeps Running` is enabled by default. With it on, clicking the window close button hides the window and keeps the menu bar app and auto-ingest running in the background. Turn it off if you want the close button to quit the app. `Hide Setup Required on Startup` suppresses the native startup setup prompt; setup status remains available in the app. `Start at Login` may require macOS approval in System Settings.

[Back to top](#top)

## Local Env And Gitignore

The GitHub upload excludes dotfiles. After downloading the project, create local `.env` and `.gitignore` files manually if you run the Node agent directly.

See:

```text
docs/ENV_AND_GITIGNORE.md
```

The native app uses:

```text
~/Library/Application Support/LLM Wiki Agent/config.env
```

[Back to top](#top)

## Clean GitHub Upload

This repository is prepared so release uploads should not include:

- files or folders starting with `.`
- local vaults
- current user data
- API keys
- Obsidian app settings

Create a clean upload folder:

```bash
./scripts/prepare_github_release.sh
```

Upload:

```text
release-template/llm-wiki-agent/
```

[Back to top](#top)

## Credits

- LLM Wiki idea: Andrej Karpathy, `karpathy/llm-wiki.md`.
- Obsidian: https://obsidian.md
- Obsidian Web Clipper: https://obsidian.md/clipper
- OpenAI / Codex CLI for subscription-backed local agent access.
- Anthropic and Google Gemini for supported provider options.

This project is an independent local wrapper and workflow implementation. It is not affiliated with Obsidian, OpenAI, Anthropic, Google, or Andrej Karpathy.

[Back to top](#top)
