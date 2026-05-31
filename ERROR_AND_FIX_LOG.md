# Error And Fix Log

## 2026-05-31 - Arc Extension Media Capture Waited For Playback Completion

- **Area:** `extension/arc-clipper`
- **Symptom:** `Prepare page media` waited for playback to finish, for a stream end marker, or for an idle timeout before preparing the clip.
- **Cause:** The popup media path called the playback polling collector before packaging media.
- **Fix:** The popup media path now collects the current media state once, expands detected HLS/DASH manifests directly from source, and requests discovered segment/chunk URLs immediately.
- **Fallback:** If a site does not expose a readable `.m3u8` or `.mpd` manifest, the extension still uses observed media requests and URL-only traceability.
- **Verification:** `node --check extension/arc-clipper/background.js` and `npm test`.

## 2026-05-31 - macOS App Reinstall Build Race

- **Area:** `scripts/install_macos_app.sh`
- **Symptom:** First reinstall attempt failed with `input file ... main.swift was modified during the build`.
- **Likely cause:** The repo is inside iCloud Drive, so file syncing can race SwiftPM/Xcode source reads.
- **Fix:** Retried the install after the file state settled.
- **Verification:** Second `./scripts/install_macos_app.sh` run built and installed `/Applications/LLM Wiki Agent.app`.
