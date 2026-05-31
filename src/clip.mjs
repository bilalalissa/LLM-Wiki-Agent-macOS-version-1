import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, listVaults, slugify, vaultName } from "./vaults.mjs";

const maxTextChars = 240000;
const maxHtmlChars = 120000;
const maxAssetBytes = 60 * 1024 * 1024;
const maxTranscriptChars = 180000;

export async function saveBrowserClip(config, payload) {
  const vaultPath = resolveVault(config, payload?.vault);
  const captureType = normalizeCaptureType(payload?.captureType);
  const now = new Date();
  const title = cleanText(payload?.title || payload?.url || `${captureType} clip`, 160) || `${captureType} clip`;
  const tags = normalizeTags(payload?.tags);
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = uniquePath(path.join(
    vaultPath,
    "raw",
    "input",
    `${stamp}--browser--${captureType}--${slugify(title)}.md`
  ));
  const savedMedia = await saveClipMedia(vaultPath, payload?.media, stamp, {
    payload: payload || {},
    captureType,
    title
  });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, renderClipMarkdown({
    payload: payload || {},
    captureType,
    title,
    tags,
    now,
    savedMedia
  }), "utf8");
  return {
    vault: vaultName(vaultPath),
    file: relativeVaultPath(vaultPath, file),
    assets: savedMedia.flatMap((item) => [item.path, item.transcriptPath].filter(Boolean))
  };
}

function resolveVault(config, requested) {
  const vaults = listVaults(config.vaultsRoot);
  const name = String(requested || "").trim();
  const match = vaults.find((item) => vaultName(item) === name) || vaults[0];
  if (!match) throw new Error("No Obsidian vault is available for clipping.");
  return match;
}

function normalizeCaptureType(value) {
  const text = String(value || "").toLowerCase();
  return new Set(["selection", "page", "media"]).has(text) ? text : "page";
}

function renderClipMarkdown({ payload, captureType, title, tags, now, savedMedia }) {
  const url = cleanText(payload.url || "", 2000);
  const text = cleanText(payload.text || "", maxTextChars);
  const html = cleanText(payload.html || "", maxHtmlChars);
  const frontmatterTags = [...new Set(["browser-clip", ...tags])];
  const lines = [
    "---",
    "type: browser-clip",
    "source: arc-extension",
    `capture_type: ${captureType}`,
    `created: ${now.toISOString()}`,
    url ? `url: ${quoteYaml(url)}` : "url: \"\"",
    `title: ${quoteYaml(title)}`,
    "tags:",
    ...frontmatterTags.map((tag) => `  - ${quoteYaml(tag)}`),
    "---",
    "",
    `# Browser clip - ${title}`,
    "",
    "## Source",
    url ? `- URL: ${url}` : "- URL: none",
    `- Captured: ${now.toISOString()}`,
    `- Capture type: ${captureType}`,
    tags.length ? `- Tags: ${tags.map((tag) => `#${tag}`).join(", ")}` : "- Tags: none",
    "",
    "## Content",
    "",
    text || "_No readable text was captured. Check the media and source URL below._",
    ""
  ];

  if (savedMedia.length) {
    lines.push("## Media", "");
    for (const media of savedMedia) {
      if (media.kind === "video-download") {
        lines.push(`- ${media.label}`);
        lines.push(`  - Download status: ${media.status || "unknown"}`);
        if (media.path) lines.push(`![[${media.path}]]`);
        if (media.transcriptPath) lines.push(`  - Transcript file: [[${media.transcriptPath}]]`);
        if (media.error) lines.push(`  - Error: ${media.error}`);
      } else if (media.kind === "stream-reference") {
        lines.push(`- ${media.label}`);
        lines.push(`  - Stream references received: ${media.count}`);
        lines.push("  - Stream chunks were not saved to vault assets.");
      } else if (media.path) {
        lines.push(`- ${media.label}`);
        lines.push(`![[${media.path}]]`);
      } else if (media.url) {
        lines.push(`- [${media.label}](${media.url})`);
      }
      if (media.sourceUrl && media.sourceUrl !== media.url) {
        lines.push(`  - Original URL: ${media.sourceUrl}`);
      }
    }
    lines.push("");
  }

  const transcriptText = savedMedia
    .filter((media) => media.kind === "video-download" && media.transcriptText)
    .map((media) => media.transcriptText)
    .join("\n\n")
    .trim();
  if (transcriptText) {
    lines.push("## Transcript");
    lines.push("");
    lines.push(transcriptText);
    lines.push("");
  }

  if (html && captureType !== "media") {
    lines.push("## Captured HTML");
    lines.push("");
    lines.push("```html");
    lines.push(html);
    lines.push("```");
    lines.push("");
  }

  lines.push("## Processing Notes");
  lines.push("");
  lines.push("- This source was created by the LLM Wiki Agent browser companion extension.");
  lines.push("- Review media URLs manually if the browser could not export the binary file.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function saveClipMedia(vaultPath, mediaList, stamp, options = {}) {
  const pageVideo = pageVideoRequest(options.payload, options.captureType);
  if (pageVideo) {
    return [await saveSinglePageVideo(vaultPath, pageVideo, stamp, options.title)];
  }
  const items = Array.isArray(mediaList) ? mediaList : [];
  const streamItems = items.filter(isStreamChunkMedia);
  const regularItems = items.filter((item) => !isStreamChunkMedia(item));
  const saved = [];
  if (streamItems.length >= 3) {
    saved.push({
      label: "Browser video/audio stream reference",
      kind: "stream-reference",
      count: streamItems.length,
      downloaded: 0
    });
  } else {
    regularItems.unshift(...streamItems);
  }
  for (const [index, media] of regularItems.entries()) {
    const label = cleanText(media?.alt || media?.title || media?.filename || media?.url || `media ${index + 1}`, 140) || `media ${index + 1}`;
    const sourceUrl = cleanText(media?.url || media?.src || "", 2000);
    const dataUrl = String(media?.dataUrl || "");
    if (dataUrl.startsWith("data:")) {
      try {
        saved.push(saveDataUrlAsset(vaultPath, dataUrl, stamp, index, label, sourceUrl));
        continue;
      } catch {
        // Fall through to URL-only media so the source still keeps a trace.
      }
    }
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
      try {
        saved.push(await downloadUrlAsset(vaultPath, sourceUrl, stamp, index, label));
        continue;
      } catch {
        // Fall through to URL-only media so the source still keeps a trace.
      }
    }
    if (sourceUrl) saved.push({ label, url: sourceUrl, sourceUrl });
  }
  return saved;
}

function pageVideoRequest(payload, captureType) {
  if (captureType !== "media") return null;
  const explicit = payload?.singleVideoRequest || payload?.mediaDownload || {};
  const url = cleanText(explicit.url || payload?.url || "", 2000);
  if (!isYouTubePageUrl(url)) return null;
  return {
    provider: "youtube",
    url
  };
}

async function saveSinglePageVideo(vaultPath, request, stamp, title) {
  const label = "Single YouTube video file";
  const dir = path.join(vaultPath, "raw", "assets", "browser-clips");
  const prefix = `${stamp}--single-video--${slugify(title || "youtube-video")}`;
  const sourceUrl = request.url;
  ensureDir(dir);

  if (process.env.LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD === "1") {
    return {
      label,
      kind: "video-download",
      status: "skipped",
      sourceUrl,
      error: "External video download is disabled by LLM_WIKI_DISABLE_EXTERNAL_VIDEO_DOWNLOAD=1."
    };
  }

  const ytDlp = ytDlpInvocation();
  const outputTemplate = path.join(dir, `${prefix}.%(ext)s`);
  try {
    await runCommand(ytDlp.command, [
      ...ytDlp.argsPrefix,
      "--no-playlist",
      "--no-part",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      "ar-orig,ar.*,ar,en.*,en",
      "--convert-subs",
      "srt",
      "-f",
      "b[ext=mp4][height<=360]/bv*[height<=360][ext=mp4]+ba[ext=m4a]/bv*[height<=360]+ba/b[height<=360]/b",
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      sourceUrl
    ], { timeoutMs: 15 * 60 * 1000 });
  } catch (error) {
    const transcript = await saveYoutubeTranscript(vaultPath, dir, prefix, sourceUrl, ytDlp).catch(() => null);
    return {
      label,
      kind: "video-download",
      status: "failed",
      sourceUrl,
      transcriptPath: transcript?.path || "",
      transcriptText: transcript?.text || "",
      error: cleanText(error.message, 500)
    };
  }

  const files = fs.readdirSync(dir)
    .filter((file) => file.startsWith(prefix) && !file.endsWith(".part") && !file.endsWith(".ytdl"))
    .map((file) => path.join(dir, file));
  const videoFile = files.find((file) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(file));
  const transcriptFile = preferredTranscriptFile(files);
  if (!videoFile) {
    return {
      label,
      kind: "video-download",
      status: "failed",
      sourceUrl,
      transcriptPath: transcriptFile ? relativeVaultPath(vaultPath, transcriptFile) : "",
      transcriptText: transcriptFile ? readTranscriptText(transcriptFile) : "",
      error: "yt-dlp completed but no merged video file was produced."
    };
  }
  return {
    label,
    kind: "video-download",
    status: "downloaded",
    path: relativeVaultPath(vaultPath, videoFile),
    transcriptPath: transcriptFile ? relativeVaultPath(vaultPath, transcriptFile) : "",
    transcriptText: transcriptFile ? readTranscriptText(transcriptFile) : "",
    sourceUrl
  };
}

async function saveYoutubeTranscript(vaultPath, dir, prefix, sourceUrl, ytDlp) {
  await runCommand(ytDlp.command, [
    ...ytDlp.argsPrefix,
    "--no-playlist",
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "ar-orig,ar.*,ar,en.*,en",
    "--convert-subs",
    "srt",
    "-o",
    path.join(dir, `${prefix}.%(ext)s`),
    sourceUrl
  ], { timeoutMs: 5 * 60 * 1000 });
  const files = fs.readdirSync(dir)
    .filter((file) => file.startsWith(prefix) && !file.endsWith(".part") && !file.endsWith(".ytdl"))
    .map((file) => path.join(dir, file));
  const transcriptFile = preferredTranscriptFile(files);
  if (!transcriptFile) return null;
  return {
    path: relativeVaultPath(vaultPath, transcriptFile),
    text: readTranscriptText(transcriptFile)
  };
}

function preferredTranscriptFile(files) {
  const transcripts = files.filter((file) => /\.(srt|vtt)$/i.test(file));
  return transcripts.find((file) => /\.ar-orig\.(srt|vtt)$/i.test(file)) ||
    transcripts.find((file) => /\.ar[.-]/i.test(file)) ||
    transcripts.find((file) => /\.en[.-]/i.test(file)) ||
    transcripts[0] ||
    "";
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out while downloading the single page video.`));
    }, options.timeoutMs || 0x7fffffff);
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new Error("yt-dlp is not installed or not on PATH. Install it with `brew install yt-dlp` or set YT_DLP_PATH."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`yt-dlp failed with exit code ${code}. ${output.trim()}`.trim()));
      }
    });
  });
}

function ytDlpInvocation() {
  const node = nodeRuntimePath();
  const argsPrefix = node
    ? ["--js-runtimes", `node:${node}`, "--remote-components", "ejs:github"]
    : [];
  if (process.env.YT_DLP_PATH) return { command: process.env.YT_DLP_PATH, argsPrefix };
  const home = process.env.HOME || "";
  const candidates = [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    path.join(home, ".local", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.13", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.12", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.11", "bin", "yt-dlp"),
    path.join(home, "Library", "Python", "3.10", "bin", "yt-dlp")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: candidate, argsPrefix };
  }
  return { command: "yt-dlp", argsPrefix };
}

function nodeRuntimePath() {
  if (process.env.YT_DLP_JS_RUNTIME) return process.env.YT_DLP_JS_RUNTIME;
  const home = process.env.HOME || "";
  const candidates = [
    process.execPath,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    path.join(home, ".nvm", "current", "bin", "node")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function readTranscriptText(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const text = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line &&
        line !== "WEBVTT" &&
        !/^\d+$/.test(line) &&
        !/^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(line))
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleanText(text, maxTranscriptChars);
  } catch {
    return "";
  }
}

async function downloadUrlAsset(vaultPath, sourceUrl, stamp, index, label) {
  return downloadUrlAssetInDir(path.join(vaultPath, "raw", "assets", "browser-clips"), vaultPath, sourceUrl, stamp, index, label);
}

async function downloadUrlAssetInDir(dir, vaultPath, sourceUrl, stamp, index, label) {
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    headers: {
      "user-agent": "LLM Wiki Agent Browser Clipper/0.1"
    }
  });
  if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxAssetBytes) throw new Error("Media asset is too large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.byteLength || buffer.byteLength > maxAssetBytes) throw new Error("Media asset is too large.");
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
  const ext = extensionForMime(mime) || extensionFromUrl(sourceUrl) || ".bin";
  ensureDir(dir);
  const file = uniquePath(path.join(dir, `${stamp}--${String(index + 1).padStart(2, "0")}--${slugify(label)}${ext}`));
  fs.writeFileSync(file, buffer);
  return {
    label,
    path: relativeVaultPath(vaultPath, file),
    url: "",
    sourceUrl
  };
}

function saveDataUrlAsset(vaultPath, dataUrl, stamp, index, label, sourceUrl) {
  return saveDataUrlAssetInDir(path.join(vaultPath, "raw", "assets", "browser-clips"), vaultPath, dataUrl, stamp, index, label, sourceUrl);
}

function saveDataUrlAssetInDir(dir, vaultPath, dataUrl, stamp, index, label, sourceUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL.");
  const mime = match[1] || "application/octet-stream";
  const buffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
  if (buffer.byteLength > maxAssetBytes) throw new Error("Media asset is too large.");
  const ext = extensionForMime(mime) || extensionFromUrl(sourceUrl) || ".bin";
  ensureDir(dir);
  const file = uniquePath(path.join(dir, `${stamp}--${String(index + 1).padStart(2, "0")}--${slugify(label)}${ext}`));
  fs.writeFileSync(file, buffer);
  return {
    label,
    path: relativeVaultPath(vaultPath, file),
    url: "",
    sourceUrl
  };
}

function isStreamChunkMedia(media) {
  const value = `${media?.url || media?.src || ""} ${media?.filename || ""} ${media?.alt || ""}`.toLowerCase();
  return /\.(m4s|mpd|m3u8|ts|cmfv|cmfa)(\?|#|\s|$)/.test(value) ||
    /(^|\/\/|\.)(googlevideo\.com|youtube\.com)\//.test(value) && /videoplayback|\/api\/manifest|\/ptracking/.test(value) ||
    /i\.ytimg\.com\/sb\/|\/storyboard/.test(value) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(value) ||
    /(^|\b)(init|seg[_-]?\d+|chunk[_-]?\d+)[^/\s]*\.(mp4|ts|m4s)(\?|#|\s|$)/.test(value) ||
    /cloudflarestream\.com/.test(value) && /(manifest|playlist|chunk|segment|seg_|\.m4s|\.mpd|\.m3u8|\.ts|\/video\/|\/audio\/)/.test(value);
}

function isYouTubePageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtube.com" && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/")) ||
      host === "youtu.be";
  } catch {
    return false;
  }
}

function extensionForMime(mime) {
  return {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov"
  }[String(mime).toLowerCase()];
}

function extensionFromUrl(value) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    return ext && ext.length <= 8 ? ext : "";
  } catch {
    return "";
  }
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique clip file name.");
}

function relativeVaultPath(vaultPath, file) {
  return path.relative(vaultPath, file).replace(/\\/g, "/");
}

function cleanText(value, maxChars) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[Content truncated during browser export.]` : text;
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item || "")
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9/_-]/g, "")
      .replace(/^\/+|\/+$/g, "")
      .slice(0, 64);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

function quoteYaml(value) {
  return JSON.stringify(String(value || ""));
}
