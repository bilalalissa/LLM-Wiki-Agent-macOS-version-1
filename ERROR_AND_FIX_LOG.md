# Error And Fix Log

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
- **Fix:** normal auto-ingest now processes new raw candidates only; pending media reprocessing is opt-in with `LLM_WIKI_REPROCESS_PENDING_MEDIA=1`, ingest loops yield between files, and expensive sidebar topic and notes scans are lazy instead of startup work.
- **Verification:** `/api/status` after reinstall.
