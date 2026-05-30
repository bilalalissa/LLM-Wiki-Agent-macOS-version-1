# LLM Wiki Agent Clipper For Arc

This is an unpacked Chromium extension for Arc. It sends selected text, media links, and whole browser pages to the local LLM Wiki Agent app.

## Install In Arc

1. Start `LLM Wiki Agent.app`.
2. Open `arc://extensions` in Arc.
3. Turn on Developer Mode.
4. Click `Load unpacked`.
5. Select this folder:

```text
extension/arc-clipper
```

## Use

1. Click the extension icon.
2. Keep the Agent URL as `http://127.0.0.1:8789` unless your app uses a different port.
3. Pick an Obsidian vault.
4. Use one of:

- `Prepare selection`: collects selected browser text and nearby media, then shows a review screen.
- `Prepare page`: collects page text, HTML, and media references, then shows a review screen.
- `Prepare page media`: downloads media found on the page when browser or server access permits it, then shows a review screen.
- Right-click selected text, a page, a link, image, audio, or video and choose a LLM Wiki clip action.

The popup shows a progress bar while media downloads are attempted. Review the title, text length, media count, and per-media download status before clicking `Submit to vault`.

For video pages, click `Prepare page media` while the video is playing and keep the popup open. The extension keeps collecting chunk URLs until playback ends, a stream manifest exposes an end marker such as `#EXT-X-ENDLIST`, or playback is no longer active and no new chunks arrive for the idle window. Stream chunks are reviewed as one video/audio package and are saved as a hidden package so the wiki, sidebar, and Files tab do not fill with individual chunk files.

The extension writes a markdown source into:

```text
raw/input/
```

When browser permissions allow it, media binaries are downloaded and saved into:

```text
raw/assets/browser-clips/
```

The extension detects media from page elements, resource timing entries, and browser requests. It first tries to send actual bytes from the browser, including same-session media where possible. If that fails, the local agent tries to download public media URLs. If neither route can access the media file, the markdown source keeps the original media URL for traceability.
