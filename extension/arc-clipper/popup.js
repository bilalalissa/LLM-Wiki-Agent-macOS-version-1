const defaultServerUrl = "http://127.0.0.1:8789";

const serverUrlInput = document.querySelector("#server-url");
const vaultSelect = document.querySelector("#vaults");
const statusEl = document.querySelector("#status");
const progressWrap = document.querySelector("#progress-wrap");
const progressEl = document.querySelector("#progress");
const progressLabel = document.querySelector("#progress-label");
const progressPercent = document.querySelector("#progress-percent");
const dismissStateButton = document.querySelector("#dismiss-state");
const preview = document.querySelector("#preview");
const previewTitleInput = document.querySelector("#preview-title");
const previewTagsInput = document.querySelector("#preview-tags");
const mediaList = document.querySelector("#media-list");
const submitButton = document.querySelector("#submit");

let activeRequestId = "";
let statePoll = 0;

document.querySelector("#refresh").addEventListener("click", refreshVaults);
document.querySelector("#clip-selection").addEventListener("click", () => prepare("selection"));
document.querySelector("#clip-page").addEventListener("click", () => prepare("page"));
document.querySelector("#clip-media").addEventListener("click", () => prepare("media"));
submitButton.addEventListener("click", submitPrepared);
dismissStateButton.addEventListener("click", clearClipState);
serverUrlInput.addEventListener("change", saveSettings);
vaultSelect.addEventListener("change", saveSettings);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "clipState") {
    renderClipState(message.state);
    return false;
  }
  if (message?.type !== "clipProgress" || message.requestId !== activeRequestId) return false;
  showProgress(message.percent, message.message);
  return false;
});

await loadSettings();
await refreshVaults();
await restoreClipState();

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
  setActionButtonsDisabled(true);
  showProgress(2, "Starting...");
  dismissStateButton.hidden = true;
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
    setActionButtonsDisabled(false);
  });
  startStatePolling();
}

function submitPrepared() {
  submitButton.disabled = true;
  setActionButtonsDisabled(true);
  setStatus("Submitting to vault...");
  showProgress(10, "Submitting to vault...");
  chrome.runtime.sendMessage({
    type: "submitPreparedClip",
    updates: {
      title: previewTitleInput.value,
      tags: previewTagsInput.value
    }
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
    showProgress(100, "Saved.");
    dismissStateButton.hidden = false;
    setActionButtonsDisabled(false);
  });
  startStatePolling();
}

function renderPreview(result) {
  document.querySelector("#preview-type").textContent = result.captureType || "";
  previewTitleInput.value = result.title || "";
  previewTagsInput.value = Array.isArray(result.tags) ? result.tags.join(", ") : "";
  document.querySelector("#preview-text").textContent = `${result.textLength || 0} characters`;
  const summary = result.summary || {};
  document.querySelector("#preview-media-summary").textContent =
    `${summary.downloaded || 0}/${summary.total || 0} downloaded, ${summary.urlOnly || 0} URL-only`;
  mediaList.innerHTML = "";
  const mediaItems = Array.isArray(result.media) ? result.media : [];
  const streamItems = mediaItems.filter(isStreamChunkMedia);
  const visibleItems = mediaItems.filter((media) => !isStreamChunkMedia(media));
  if (streamItems.length >= 3) {
    const item = document.createElement("li");
    item.className = "url-only";
    item.innerHTML = `
      <strong>Browser video/audio stream reference</strong>
      <span>stream · ${streamItems.length} source parts detected</span>
      <small>Stream chunks are summarized in this clip and are not sent to the agent or saved into vault assets.</small>
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
  setActionButtonsDisabled(false);
}

async function restoreClipState() {
  const response = await sendRuntimeMessage({ type: "getClipState" }).catch(() => null);
  if (response?.ok) renderClipState(response.state);
}

function renderClipState(state) {
  if (!state || state.status === "idle") return;
  activeRequestId = state.requestId || activeRequestId;
  if (state.status === "preparing") {
    preview.hidden = true;
    submitButton.disabled = true;
    dismissStateButton.hidden = true;
    setActionButtonsDisabled(true);
    showProgress(state.percent || 2, state.message || "Preparing clip...");
    setStatus("Preparing continues in the background. You can reopen this popup to check progress.");
    startStatePolling();
    return;
  }
  if (state.status === "ready") {
    if (state.result) renderPreview(state.result);
    showProgress(100, state.message || "Ready to submit.");
    dismissStateButton.hidden = true;
    setStatus("Clip is ready. Review the title and tags, then submit.");
    stopStatePolling();
    return;
  }
  if (state.status === "submitting") {
    submitButton.disabled = true;
    dismissStateButton.hidden = true;
    setActionButtonsDisabled(true);
    showProgress(state.percent || 10, state.message || "Submitting to vault...");
    setStatus("Submitting continues in the background. You can reopen this popup to check progress.");
    startStatePolling();
    return;
  }
  if (state.status === "saved") {
    preview.hidden = true;
    showProgress(100, state.message || "Saved.");
    dismissStateButton.hidden = false;
    setActionButtonsDisabled(false);
    setStatus(state.savedResult?.file ? `Saved to ${state.savedResult.file}` : "Saved.");
    stopStatePolling();
    return;
  }
  if (state.status === "error") {
    fail(state.error || state.message || "Clip failed.");
    dismissStateButton.hidden = false;
    setActionButtonsDisabled(false);
    stopStatePolling();
  }
}

async function clearClipState() {
  await sendRuntimeMessage({ type: "clearClipState" }).catch(() => null);
  progressWrap.hidden = true;
  preview.hidden = true;
  dismissStateButton.hidden = true;
  setActionButtonsDisabled(false);
  setStatus("Ready.");
}

function startStatePolling() {
  if (statePoll) return;
  statePoll = setInterval(restoreClipState, 1000);
}

function stopStatePolling() {
  if (!statePoll) return;
  clearInterval(statePoll);
  statePoll = 0;
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
  setActionButtonsDisabled(false);
  setStatus(message);
  showProgress(0, "Stopped.");
}

function setActionButtonsDisabled(disabled) {
  document.querySelector("#clip-selection").disabled = disabled;
  document.querySelector("#clip-page").disabled = disabled;
  document.querySelector("#clip-media").disabled = disabled;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
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
