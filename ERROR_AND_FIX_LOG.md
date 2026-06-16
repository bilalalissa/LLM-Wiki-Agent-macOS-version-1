# Error And Fix Log

## 2026-06-16 - Saving Notes Removed In-Page Highlights

- **Area:** `src/server.mjs`
- **Symptom:** Adding a note, including notes with attached media/files, removed highlighted text from the displayed source/result under revision.
- **Cause:** The note-save flow called `refreshResultAnnotations()`, which rebuilt the Chat/Local result HTML from markdown. That redraw preserved saved note indicators but discarded temporary `mark.agent-highlight` elements.
- **Fix:** Saved notes now remember which result surface they came from and add only the new note indicator in place. The result is no longer fully re-rendered during note save, so existing highlights stay visible.
- **Verification:** `node --check src/server.mjs`, `LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD=1 npm test`, app reinstall, and served HTML verification for targeted note annotation.

## 2026-06-04 - Topics Sidebar Did Not Refresh After New Topics

- **Area:** `src/server.mjs`
- **Symptom:** `Topics & Insights` search sidebar could keep showing the first loaded topic list and miss newly ingested topics until the app/page was manually reloaded.
- **Cause:** The sidebar used a lazy `sideTopicsLoaded` flag and never invalidated or reloaded its local topic cache after `/api/topics` refreshed.
- **Fix:** The sidebar now tracks the `/api/topics` `updatedAt` timestamp, refreshes from the server every few seconds after it has been opened, and re-renders automatically when the topic cache timestamp changes. The Topics tab also synchronizes the sidebar cache when it loads newer topic data.
- **Verification:** `node --check src/server.mjs`, `LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD=1 npm test`, app reinstall, and served HTML verification for `refreshSideTopicsIfStale`.

## 2026-05-31 - Large YouTube Clips Needed Preflight Options

- **Area:** `src/clip.mjs`, `src/server.mjs`, `extension/arc-clipper`
- **Symptom:** A large target video could fail or consume too much time/storage only after the user submitted the clip.
- **Cause:** The single-video path downloaded during final submit without first estimating file size or asking the user where the large video should be saved.
- **Fix:** Added `/api/clip-preflight` and popup preflight UI. YouTube clips now estimate selected format size before submit, warn when above the raw-vault safety limit, and offer transcript-only, temporary copy outside `raw/`, or explicit raw-vault video archive handling. The server also defaults large direct/API clips to transcript-only when no explicit handling choice is supplied.
- **Verification:** `node --check src/clip.mjs`, `node --check src/server.mjs`, `node --check extension/arc-clipper/background.js`, `node --check extension/arc-clipper/popup.js`, and `npm test`.

## 2026-05-31 - YouTube Single-Video Download Needed JS Runtime

- **Area:** `src/clip.mjs`, `README.md`
- **Symptom:** The Python/cybersecurity YouTube clip saved a raw source but did not download the video or transcript.
- **Cause:** `yt-dlp` found YouTube subtitles, but the agent command did not pass a supported JavaScript runtime, so extraction failed before the merged video/subtitle save path completed.
- **Fix:** The agent now passes Node to `yt-dlp` with remote EJS challenge components when available, prefers Arabic captions, uses a bounded 360p single-video format to avoid accidental best-quality multi-gigabyte downloads on long videos, and attempts a transcript-only fallback if the video download fails.
- **Verification:** `yt-dlp --js-runtimes node:/usr/local/bin/node --remote-components ejs:github --skip-download --write-auto-subs --write-subs --sub-langs 'ar-orig,ar.*,ar,en.*,en' ...` successfully downloaded Arabic captions for the referenced video; `node --check src/clip.mjs`; `npm test`.

## 2026-05-31 - Files And Archive Needed Bulk Keyboard Selection

- **Area:** `src/server.mjs`
- **Symptom:** Files and Archive rows could only be selected one checkbox at a time, which made bulk archive, restore, delete, merge, and rename workflows slow.
- **Cause:** The tables rendered independent checkboxes without a shared row selection state or keyboard focus model.
- **Fix:** Files and Archive now preserve visible row selection state and support row/checkbox click toggles, `Shift`+click, `Shift`+Arrow range selection, `Cmd`+click non-adjacent toggles, `Cmd`+Arrow edge jumps, and `Cmd`+A select-all for visible rows.
- **Verification:** `node --check src/server.mjs`.

## 2026-05-31 - YouTube Clip Saved Chunks Instead Of One Video

- **Area:** `extension/arc-clipper`, `src/clip.mjs`
- **Symptom:** A clipped YouTube page saved many `videoplayback` chunk files and storyboard images into the vault, then treated that partial set as the media clip.
- **Cause:** YouTube `googlevideo.com/videoplayback` URLs do not always expose normal stream file extensions, so the chunk filters classified them as downloadable media instead of stream parts.
- **Fix:** YouTube watch/Shorts page media clips now submit one page-video request. The extension excludes `videoplayback` chunks, storyboard images, thumbnails, and sub-videos, and the agent uses `yt-dlp` when available to save one merged video plus available Arabic/English subtitle transcript text.
- **Verification:** `node --check extension/arc-clipper/background.js`, `node --check extension/arc-clipper/popup.js`, `node --check src/clip.mjs`, and `npm test`.

## 2026-05-31 - Extension Popup Closed During Long Clip Work

- **Area:** `extension/arc-clipper`
- **Symptom:** If the user clicked elsewhere or switched apps, Arc closed the extension popup and the user lost visible feedback while media preparation or submit was still running.
- **Cause:** Chromium extension popups are intentionally dismissed on focus loss, and progress was only rendered in the open popup callback.
- **Fix:** Clip preparation/submission state now lives in the background worker, is mirrored to extension storage, restores when the popup is reopened, and uses action badge text for ongoing/ready/saved/error indication.
- **Verification:** `node --check extension/arc-clipper/background.js`, `node --check extension/arc-clipper/popup.js`, and `npm test`.

## 2026-05-31 - App Tabs Empty While Vault Scans Blocked The Server

- **Area:** `src/server.mjs`, `src/tab-data-worker.mjs`
- **Symptom:** Chat, Local, Files, Archive, Topics, Provider, and Notes could appear empty because the app server stopped answering API requests while a vault scan was reading iCloud-backed files.
- **Cause:** Heavy tab data requests performed synchronous vault file reads in the main Node process, so one slow iCloud file read blocked all other endpoints, including `/api/status`, `/api/vaults`, and `/api/provider-status`.
- **Fix:** Files, Archive, Topics, and Notes tab data now refresh through independent worker processes with cached responses and timeouts. The UI retries while each tab cache warms up, and Provider/status requests remain responsive.
- **Verification:** `node --check src/server.mjs`, `node --check src/tab-data-worker.mjs`, `npm test`, and timed `/api/status`, `/api/vaults`, `/api/files`, `/api/archives`, `/api/topics`, `/api/notes`, `/api/provider-status` checks after reinstall.

## 2026-05-31 - Arc Extension Media Capture Waited For Playback Completion

- **Area:** `extension/arc-clipper`
- **Symptom:** `Prepare page media` waited for playback to finish, for a stream end marker, or for an idle timeout before preparing the clip.
- **Cause:** The popup media path called the playback polling collector before packaging media.
- **Fix:** The popup media path now collects the current media state once, inspects detected HLS/DASH manifests directly from source for chunk counts, and sends one clipped content item without uploading chunk files.
- **Fallback:** If a site does not expose a readable `.m3u8` or `.mpd` manifest, the extension still uses observed media requests and URL-only traceability.
- **Verification:** `node --check extension/arc-clipper/background.js` and `npm test`.

## 2026-05-31 - Browser Clips Needed User Tags Before Submit

- **Area:** `extension/arc-clipper`, `src/clip.mjs`
- **Symptom:** Users could review the clip title before submit, but could not add tags to the clipped content.
- **Cause:** The popup submit flow only forwarded title edits to the prepared clip payload.
- **Fix:** Added a tags field to the review screen, forwards normalized tags with the single clipped-content payload, and writes tags to Markdown frontmatter plus the source section.
- **Verification:** `node --check extension/arc-clipper/popup.js`, `node --check extension/arc-clipper/background.js`, `node --check src/clip.mjs`, and `npm test`.

## 2026-05-31 - macOS App Reinstall Build Race

- **Area:** `scripts/install_macos_app.sh`
- **Symptom:** First reinstall attempt failed with `input file ... main.swift was modified during the build`.
- **Likely cause:** The repo is inside iCloud Drive, so file syncing can race SwiftPM/Xcode source reads.
- **Fix:** Retried the install after the file state settled.
- **Verification:** Second `./scripts/install_macos_app.sh` run built and installed `/Applications/LLM Wiki Agent.app`.

## 2026-05-31 - Arc Extension Reload Invalidated Existing Content Script

- **Area:** `extension/arc-clipper/content.js`
- **Symptom:** Arc extension errors showed `Uncaught Error: Extension context invalidated` at `chrome.runtime.sendMessage` after reloading the unpacked extension on an already-open YouTube tab.
- **Cause:** The previous content script instance kept running after Arc invalidated the old extension context.
- **Fix:** Observed-media messages now go through a guarded runtime sender that silently skips sends when the extension context has been invalidated.
- **Verification:** `node --check extension/arc-clipper/content.js`.

## 2026-05-31 - Agent UI And Extension Could Not Connect While Startup Scan Was Running

- **Area:** `src/vaults.mjs`, `src/server.mjs`
- **Symptom:** The native app opened, but tabs were empty, Obsidian content did not load, `/api/status` timed out, and the browser extension could not reach the agent even though port `8789` was listening.
- **Cause:** Startup auto-ingest recursively walked `raw/assets/` before filtering it out. Browser media captures can store many stream chunks there, which can monopolize the Node event loop during startup scans.
- **Fix:** Raw candidate scanning now skips `raw/assets/` and `raw/processed/` before descending into those folders. Startup ingest also yields between vault work so the HTTP server can answer UI and extension requests.
- **Verification:** `curl --max-time 3 http://127.0.0.1:8789/api/status`, `curl --max-time 3 http://127.0.0.1:8789/api/vaults`, and `npm test`.

## 2026-05-31 - Desktop Topics Sidebar Overlapped Header And Chat Controls

- **Area:** `src/server.mjs`
- **Symptom:** The `Topics & Insights` sidebar covered the header actions and made the chat control bar look cramped/overlapped on desktop windows.
- **Cause:** The sidebar used a fixed position over the page while `main` was centered with a max width and right padding, so the two areas did not reserve separate layout space.
- **Fix:** Desktop layout now reserves a right rail for the topics sidebar, widens the main content area, moves the sidebar below the header line, and lets header actions wrap when needed.
- **Verification:** `node --check src/server.mjs` and app relaunch.

## 2026-05-31 - Browser Media Capture Should Not Wait For Playback Chunks

- **Area:** `extension/arc-clipper/background.js`
- **Symptom:** Media capture needed to save user time by requesting stream chunks directly from source instead of waiting for playback to load chunks.
- **Cause:** Older playback-wait helper code remained in the extension even after the popup path started using manifest expansion.
- **Fix:** Removed the playback-completion wait helper from the background script. Stream manifests are inspected directly from source and summarized into one clipped markdown source instead of uploading chunks.
- **Verification:** `node --check extension/arc-clipper/background.js` and `npm test`.

## 2026-05-31 - Stream Capture Saved Only The First Chunk Window

- **Area:** `extension/arc-clipper/background.js`, `src/clip.mjs`
- **Symptom:** Faster media capture downloaded some stream chunks and then treated that partial set as the full media.
- **Cause:** The initial direct-manifest implementation still treated stream chunks as media payload entries.
- **Fix:** HLS/DASH manifests are now inspected for chunk counts only. The extension sends one clipped content item with manifest metadata, and the agent summarizes any received stream references without writing stream chunk assets.
- **Verification:** `node --check extension/arc-clipper/background.js`, `node --check src/clip.mjs`, and `npm test`.

## 2026-05-31 - Startup Media Reprocessing Could Block Local API

- **Area:** `src/ingest-lib.mjs`
- **Symptom:** After reinstalling, the server listened on port `8789` but `/api/status` could time out while startup ingest inspected existing media source pages.
- **Cause:** pending media reprocessing scanned existing wiki source pages as part of normal auto-ingest.
- **Fix:** normal auto-ingest now processes new raw candidates only; pending media reprocessing is opt-in with `LLM_WIKI_REPROCESS_PENDING_MEDIA=1`, ingest loops yield between files, expensive sidebar topic and notes scans are lazy instead of startup work, and heavy topics/notes API scans use async file reads so status and extension requests can interleave.
- **Verification:** `/api/status` after reinstall.
