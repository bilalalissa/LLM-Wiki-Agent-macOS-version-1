import fs from "node:fs";
import path from "node:path";
import { ensureDir, listVaults, slugify, vaultName } from "./vaults.mjs";

const maxTextChars = 240000;
const maxHtmlChars = 120000;
const maxAssetBytes = 60 * 1024 * 1024;

export async function saveBrowserClip(config, payload) {
  const vaultPath = resolveVault(config, payload?.vault);
  const captureType = normalizeCaptureType(payload?.captureType);
  const now = new Date();
  const title = cleanText(payload?.title || payload?.url || `${captureType} clip`, 160) || `${captureType} clip`;
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = uniquePath(path.join(
    vaultPath,
    "raw",
    "input",
    `${stamp}--browser--${captureType}--${slugify(title)}.md`
  ));
  const savedMedia = await saveClipMedia(vaultPath, payload?.media, stamp);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, renderClipMarkdown({
    payload: payload || {},
    captureType,
    title,
    now,
    savedMedia
  }), "utf8");
  return {
    vault: vaultName(vaultPath),
    file: relativeVaultPath(vaultPath, file),
    assets: savedMedia.filter((item) => item.path).map((item) => item.path)
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

function renderClipMarkdown({ payload, captureType, title, now, savedMedia }) {
  const url = cleanText(payload.url || "", 2000);
  const text = cleanText(payload.text || "", maxTextChars);
  const html = cleanText(payload.html || "", maxHtmlChars);
  const lines = [
    "---",
    "type: browser-clip",
    "source: arc-extension",
    `capture_type: ${captureType}`,
    `created: ${now.toISOString()}`,
    url ? `url: ${quoteYaml(url)}` : "url: \"\"",
    `title: ${quoteYaml(title)}`,
    "---",
    "",
    `# Browser clip - ${title}`,
    "",
    "## Source",
    url ? `- URL: ${url}` : "- URL: none",
    `- Captured: ${now.toISOString()}`,
    `- Capture type: ${captureType}`,
    "",
    "## Content",
    "",
    text || "_No readable text was captured. Check the media and source URL below._",
    ""
  ];

  if (savedMedia.length) {
    lines.push("## Media", "");
    for (const media of savedMedia) {
      if (media.kind === "stream-package") {
        lines.push(`- ${media.label}`);
        lines.push(`  - Stream parts detected: ${media.count}`);
        lines.push(`  - Stream parts saved: ${media.downloaded}`);
        if (media.failed) lines.push(`  - Stream parts not saved: ${media.failed}`);
        lines.push(`  - Package manifest: \`${media.path}\``);
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

async function saveClipMedia(vaultPath, mediaList, stamp) {
  const items = Array.isArray(mediaList) ? mediaList.slice(0, 400) : [];
  const streamItems = items.filter(isStreamChunkMedia);
  const regularItems = items.filter((item) => !isStreamChunkMedia(item));
  const saved = [];
  if (streamItems.length >= 3) {
    saved.push(await saveStreamPackage(vaultPath, streamItems, stamp));
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

async function saveStreamPackage(vaultPath, items, stamp) {
  const dir = path.join(vaultPath, "raw", "assets", "browser-clips", `${stamp}--stream-package`);
  ensureDir(dir);
  const saved = [];
  for (const [index, media] of items.entries()) {
    const label = cleanText(media?.alt || media?.title || media?.filename || media?.url || `stream part ${index + 1}`, 140) || `stream part ${index + 1}`;
    const sourceUrl = cleanText(media?.url || media?.src || "", 2000);
    const dataUrl = String(media?.dataUrl || "");
    try {
      if (dataUrl.startsWith("data:")) {
        saved.push(saveDataUrlAssetInDir(dir, vaultPath, dataUrl, stamp, index, label, sourceUrl));
      } else if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
        saved.push(await downloadUrlAssetInDir(dir, vaultPath, sourceUrl, stamp, index, label));
      } else if (sourceUrl) {
        saved.push({ label, sourceUrl, path: "" });
      }
    } catch (error) {
      saved.push({ label, sourceUrl, path: "", error: error.message });
    }
  }
  const manifest = {
    kind: "browser-stream-package",
    created: new Date().toISOString(),
    parts: saved
  };
  const manifestFile = path.join(dir, "stream-manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  const downloaded = saved.filter((item) => item.path).length;
  return {
    label: "Browser video/audio stream package",
    kind: "stream-package",
    path: relativeVaultPath(vaultPath, manifestFile),
    url: "",
    sourceUrl: "",
    count: items.length,
    downloaded,
    failed: saved.filter((item) => item.error).length
  };
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
  return /\.(m4s|mpd|m3u8)(\?|#|\s|$)/.test(value) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(value) ||
    /(^|\b)(init|seg[_-]?\d+|chunk[_-]?\d+)[^/\s]*\.mp4(\?|#|\s|$)/.test(value) ||
    /cloudflarestream\.com/.test(value) && /(manifest|playlist|chunk|segment|seg_|\.m4s|\.mpd|\.m3u8|\/video\/|\/audio\/)/.test(value);
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

function quoteYaml(value) {
  return JSON.stringify(String(value || ""));
}
