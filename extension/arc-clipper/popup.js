const defaultServerUrl = "http://127.0.0.1:8789";

const serverUrlInput = document.querySelector("#server-url");
const vaultSelect = document.querySelector("#vaults");
const statusEl = document.querySelector("#status");
const progressWrap = document.querySelector("#progress-wrap");
const progressEl = document.querySelector("#progress");
const progressLabel = document.querySelector("#progress-label");
const progressPercent = document.querySelector("#progress-percent");
const preview = document.querySelector("#preview");
const previewTitleInput = document.querySelector("#preview-title");
const mediaList = document.querySelector("#media-list");
const submitButton = document.querySelector("#submit");

let activeRequestId = "";

document.querySelector("#refresh").addEventListener("click", refreshVaults);
document.querySelector("#clip-selection").addEventListener("click", () => prepare("selection"));
document.querySelector("#clip-page").addEventListener("click", () => prepare("page"));
document.querySelector("#clip-media").addEventListener("click", () => prepare("media"));
submitButton.addEventListener("click", submitPrepared);
serverUrlInput.addEventListener("change", saveSettings);
vaultSelect.addEventListener("change", saveSettings);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "clipProgress" || message.requestId !== activeRequestId) return false;
  showProgress(message.percent, message.message);
  return false;
});

await loadSettings();
await refreshVaults();

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    serverUrl: defaultServerUrl,
    vault: ""
  });
  serverUrlInput.value = settings.serverUrl;
  vaultSelect.dataset.selected = settings.vault;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    serverUrl: serverUrl(),
    vault: vaultSelect.value
  });
}

async function refreshVaults() {
  setStatus("Loading vaults...");
  try {
    const response = await fetch(`${serverUrl()}/api/vaults`);
    const data = await response.json();
    const vaults = Array.isArray(data.vaults) ? data.vaults : [];
    vaultSelect.innerHTML = "";
    for (const vault of vaults) {
      const option = document.createElement("option");
      option.value = vault.name;
      option.textContent = vault.name;
      vaultSelect.append(option);
    }
    const selected = vaultSelect.dataset.selected;
    if (selected && vaults.some((vault) => vault.name === selected)) vaultSelect.value = selected;
    if (!vaultSelect.value && vaults[0]) vaultSelect.value = vaults[0].name;
    await saveSettings();
    setStatus(vaults.length ? `Ready. ${vaults.length} vault${vaults.length === 1 ? "" : "s"} detected.` : "No vaults were detected by the agent.");
  } catch {
    setStatus(`Could not reach LLM Wiki Agent at ${serverUrl()}.`);
  }
}

async function prepare(captureType) {
  await saveSettings();
  activeRequestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  preview.hidden = true;
  submitButton.disabled = true;
  showProgress(2, "Starting...");
  setStatus("Preparing clip. Review details before submitting.");
  chrome.runtime.sendMessage({ type: "prepareClip", captureType, requestId: activeRequestId }, (response) => {
    if (chrome.runtime.lastError) {
      fail(chrome.runtime.lastError.message);
      return;
    }
    if (!response?.ok) {
      fail(response?.error || "Clip preparation failed.");
      return;
    }
    renderPreview(response.result);
    showProgress(100, "Ready to submit.");
    setStatus("Review the clip details, then submit.");
  });
}

function submitPrepared() {
  submitButton.disabled = true;
  setStatus("Submitting to vault...");
  chrome.runtime.sendMessage({
    type: "submitPreparedClip",
    updates: { title: previewTitleInput.value }
  }, (response) => {
    if (chrome.runtime.lastError) {
      fail(chrome.runtime.lastError.message);
      return;
    }
    if (!response?.ok) {
      fail(response?.error || "Submit failed.");
      return;
    }
    setStatus(`Saved to ${response.result.file}`);
    preview.hidden = true;
    progressWrap.hidden = true;
  });
}

function renderPreview(result) {
  document.querySelector("#preview-type").textContent = result.captureType || "";
  previewTitleInput.value = result.title || "";
  document.querySelector("#preview-text").textContent = `${result.textLength || 0} characters`;
  const summary = result.summary || {};
  document.querySelector("#preview-media-summary").textContent =
    `${summary.downloaded || 0}/${summary.total || 0} downloaded, ${summary.urlOnly || 0} URL-only`;
  mediaList.innerHTML = "";
  const mediaItems = Array.isArray(result.media) ? result.media : [];
  const streamItems = mediaItems.filter(isStreamChunkMedia);
  const visibleItems = mediaItems.filter((media) => !isStreamChunkMedia(media));
  if (streamItems.length >= 3) {
    const downloaded = streamItems.filter((media) => media.dataUrl || media.downloadStatus === "downloaded").length;
    const item = document.createElement("li");
    item.className = downloaded ? "downloaded" : "url-only";
    item.innerHTML = `
      <strong>Browser video/audio stream package</strong>
      <span>stream · ${downloaded}/${streamItems.length} parts downloaded</span>
      <small>Stream chunks will be saved as one hidden package, not as separate wiki topics or file rows.</small>
    `;
    mediaList.append(item);
  } else {
    visibleItems.unshift(...streamItems);
  }
  for (const media of visibleItems) {
    const item = document.createElement("li");
    item.className = media.dataUrl ? "downloaded" : "url-only";
    item.innerHTML = `
      <strong>${escapeHtml(mediaLabel(media))}</strong>
      <span>${escapeHtml(media.type || "media")} · ${escapeHtml(statusText(media))}</span>
      <small>${escapeHtml(media.url || "")}</small>
      ${media.downloadError ? `<em>${escapeHtml(media.downloadError)}</em>` : ""}
    `;
    mediaList.append(item);
  }
  if (!mediaList.children.length) {
    const item = document.createElement("li");
    item.className = "url-only";
    item.textContent = "No media files were detected for this clip.";
    mediaList.append(item);
  }
  preview.hidden = false;
  submitButton.disabled = false;
}

function mediaLabel(media) {
  return media.alt || media.filename || media.url || "Media item";
}

function isStreamChunkMedia(media) {
  const value = `${media?.url || media?.src || ""} ${media?.filename || ""} ${media?.alt || ""}`.toLowerCase();
  return /\.(m4s|mpd|m3u8)(\?|#|\s|$)/.test(value) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(value) ||
    /(^|\b)(init|seg[_-]?\d+|chunk[_-]?\d+)[^/\s]*\.mp4(\?|#|\s|$)/.test(value) ||
    /cloudflarestream\.com/.test(value) && /(manifest|playlist|chunk|segment|seg_|\.m4s|\.mpd|\.m3u8|\/video\/|\/audio\/)/.test(value);
}

function statusText(media) {
  if (media.dataUrl || media.downloadStatus === "downloaded") {
    const size = media.downloadBytes ? ` (${formatBytes(media.downloadBytes)})` : "";
    return `downloaded${size}`;
  }
  return "URL-only; server will try fallback after submit";
}

function showProgress(percent, message) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  progressWrap.hidden = false;
  progressEl.value = safePercent;
  progressLabel.textContent = message || "Working...";
  progressPercent.textContent = `${safePercent}%`;
}

function fail(message) {
  submitButton.disabled = true;
  setStatus(message);
  showProgress(0, "Stopped.");
}

function serverUrl() {
  return String(serverUrlInput.value || defaultServerUrl).replace(/\/+$/, "");
}

function setStatus(message) {
  statusEl.textContent = message;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}
