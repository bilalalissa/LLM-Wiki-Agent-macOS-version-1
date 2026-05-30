const defaultServerUrl = "http://127.0.0.1:8789";
const maxInlineTransferChars = 180 * 1024 * 1024;
const maxBrowserMediaBytes = 50 * 1024 * 1024;
const mediaSettleMs = 1800;
const mediaCapturePollMs = 1000;
const mediaCaptureIdleMs = 7000;
const mediaCapturePausedIdleMs = 5 * 60 * 1000;
const mediaCaptureMaxMs = 3 * 60 * 60 * 1000;
const mediaByTab = new Map();
let preparedClip = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "clip-selection",
      title: "Clip selected text to LLM Wiki",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "clip-page",
      title: "Clip whole page to LLM Wiki",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "clip-media",
      title: "Clip media to LLM Wiki",
      contexts: ["image", "video", "audio"]
    });
    chrome.contextMenus.create({
      id: "clip-link",
      title: "Clip link to LLM Wiki",
      contexts: ["link"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab?.id) throw new Error("No active tab was available.");
    if (info.menuItemId === "clip-selection") {
      await collectAndSend(tab.id, "selection");
    } else if (info.menuItemId === "clip-page") {
      await collectAndSend(tab.id, "page");
    } else if (info.menuItemId === "clip-media") {
      await sendMediaClip(tab, info.srcUrl);
    } else if (info.menuItemId === "clip-link") {
      await sendLinkClip(tab, info.linkUrl, info.selectionText);
    }
  } catch (error) {
    console.error(error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "llmwiki:observed-media") {
    rememberMediaUrls(_sender.tab?.id ?? -1, message.pageURL, message.mediaURLs);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "clipNow") {
    handlePopupClip(message.captureType)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "prepareClip") {
    preparePopupClip(message.captureType, message.requestId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "submitPreparedClip") {
    submitPreparedClip(message.updates || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

async function handlePopupClip(captureType) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab was available.");
  return collectAndSend(tab.id, captureType);
}

async function preparePopupClip(captureType, requestId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab was available.");
  progress(requestId, 8, "Collecting page data...");
  const response = await chrome.tabs.sendMessage(tab.id, { type: "collectClip", captureType })
    .catch(async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return chrome.tabs.sendMessage(tab.id, { type: "collectClip", captureType });
    });
  if (!response?.ok) throw new Error(response?.error || "Could not collect browser content.");
  progress(requestId, 25, "Detecting media URLs...");
  if (captureType === "media") {
    await waitForMediaCaptureCompletion(tab.id, requestId);
  }
  const payload = await enrichMedia(response.payload, tab.id, requestId);
  preparedClip = payload;
  progress(requestId, 100, "Clip is ready to review.");
  return summarizePreparedClip(payload);
}

async function collectAndSend(tabId, captureType) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "collectClip", captureType })
    .catch(async () => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return chrome.tabs.sendMessage(tabId, { type: "collectClip", captureType });
    });
  if (!response?.ok) throw new Error(response?.error || "Could not collect browser content.");
  const payload = await enrichMedia(response.payload, tabId);
  return postClip(payload);
}

async function submitPreparedClip(updates = {}) {
  if (!preparedClip) throw new Error("Prepare a clip before submitting.");
  const title = String(updates.title || "").trim();
  if (title) preparedClip = { ...preparedClip, title };
  const result = await postClip(preparedClip);
  preparedClip = null;
  return result;
}

async function sendMediaClip(tab, url) {
  if (!url) throw new Error("No media URL was available.");
  const media = await mediaPayload(url, "");
  return postClip({
    captureType: "media",
    title: media.alt || tab?.title || "Browser media",
    url: tab?.url || url,
    text: `Media clipped from ${tab?.url || url}`,
    media: [media]
  });
}

async function sendLinkClip(tab, linkUrl, selectionText) {
  if (!linkUrl) throw new Error("No link URL was available.");
  return postClip({
    captureType: "selection",
    title: selectionText || linkUrl,
    url: tab?.url || linkUrl,
    text: `${selectionText || "Linked resource"}\n\n${linkUrl}`,
    media: looksLikeMedia(linkUrl) ? [await mediaPayload(linkUrl, selectionText || "")] : []
  });
}

async function enrichMedia(payload, tabId, requestId = "") {
  const items = Array.isArray(payload?.media) ? [...payload.media] : [];
  for (const observedUrl of observedMediaUrls(tabId)) {
    if (!items.some((item) => item?.url === observedUrl || item?.src === observedUrl)) {
      items.push({ url: observedUrl, alt: "", type: mediaKind(observedUrl) });
    }
  }
  const preparedItems = uniqueMediaItems(items).sort((a, b) => mediaPriority(b.url || b.src) - mediaPriority(a.url || a.src));
  const media = [];
  let inlineChars = 0;
  for (const [index, item] of preparedItems.entries()) {
    let next;
    if (item?.dataUrl) {
      next = {
        ...item,
        downloadStatus: "downloaded",
        downloadBytes: approximateDataUrlBytes(item.dataUrl),
        downloadMethod: "page-data"
      };
    } else {
      next = await mediaPayload(item.url || item.src, item.alt || item.title || "");
    }
    if (next?.dataUrl) {
      const nextSize = next.dataUrl.length;
      if (inlineChars + nextSize > maxInlineTransferChars) {
        next = { ...next };
        delete next.dataUrl;
      } else {
        inlineChars += nextSize;
      }
    }
    media.push(next);
    if (requestId) {
      const percent = preparedItems.length
        ? 30 + Math.round(((index + 1) / preparedItems.length) * 60)
        : 90;
      progress(requestId, percent, `Checked media ${index + 1} of ${preparedItems.length}.`);
    }
  }
  const summary = mediaSummary(media);
  const text = payload?.captureType === "media"
    ? [
        payload.text || `Media exported from ${payload.url || "this page"}`,
        "",
        `Detected media items: ${summary.total}`,
        `Downloaded media items before submit: ${summary.downloaded}`,
        `URL-only media items: ${summary.urlOnly}`,
        summary.failed ? `Failed media downloads: ${summary.failed}` : ""
      ].filter(Boolean).join("\n")
    : payload.text;
  return { ...payload, text, media };
}

async function mediaPayload(url, alt) {
  const base = {
    url,
    alt,
    type: mediaKind(url),
    filename: filenameFromUrl(url)
  };
  try {
    if (!url) return { ...base, downloadStatus: "missing-url", downloadError: "No media URL was available." };
    if (String(url || "").startsWith("data:")) {
      return {
        ...base,
        dataUrl: url,
        downloadStatus: "downloaded",
        downloadBytes: approximateDataUrlBytes(url),
        downloadMethod: "data-url"
      };
    }
    const response = await fetch(url, {
      credentials: "include",
      cache: "force-cache",
      redirect: "follow",
      referrerPolicy: "no-referrer-when-downgrade"
    });
    if (!response.ok) {
      return { ...base, downloadStatus: "url-only", downloadError: `Browser fetch failed: HTTP ${response.status}` };
    }
    const blob = await response.blob();
    if (blob.size > maxBrowserMediaBytes) {
      return { ...base, downloadStatus: "url-only", downloadBytes: blob.size, downloadError: "Browser download exceeded the inline transfer limit; server fallback will try after submit." };
    }
    return {
      ...base,
      dataUrl: await blobToDataUrl(blob),
      downloadStatus: "downloaded",
      downloadBytes: blob.size,
      downloadMethod: "browser-fetch"
    };
  } catch (error) {
    return { ...base, downloadStatus: "url-only", downloadError: `${error.name || "Error"}: ${error.message || "Browser fetch failed"}` };
  }
}

function rememberMediaUrls(tabId, pageURL, urls) {
  if (tabId < 0 || !Array.isArray(urls)) return;
  if (!mediaByTab.has(tabId)) {
    mediaByTab.set(tabId, { pageURL: "", urls: new Set(), lastAddedAt: 0 });
  }
  const state = mediaByTab.get(tabId);
  if (pageURL) state.pageURL = pageURL;
  for (const url of urls) {
    if (!isLikelyStreamingMediaUrl(url) || state.urls.has(url)) continue;
    state.urls.add(url);
    state.lastAddedAt = Date.now();
  }
}

function observedMediaUrls(tabId) {
  return Array.from(mediaByTab.get(tabId)?.urls || []);
}

function uniqueMediaItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const url = item?.url || item?.src || "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(item);
  }
  return result;
}

async function waitForMediaCaptureCompletion(tabId, requestId) {
  const startedAt = Date.now();
  let lastCount = observedMediaUrls(tabId).length;
  let lastChangeAt = Date.now();
  let sawActivePlayback = false;
  let sawPlayableMedia = false;
  progress(requestId, 25, "Collecting chunks while media plays...");

  while (Date.now() - startedAt < mediaCaptureMaxMs) {
    const state = await collectMediaState(tabId);
    if (state?.observedMediaURLs?.length) {
      rememberMediaUrls(tabId, state.pageURL, state.observedMediaURLs);
    }
    sawActivePlayback = sawActivePlayback || Boolean(state?.activePlayback);
    sawPlayableMedia = sawPlayableMedia || Boolean(state?.hasPlayableMedia);

    const count = observedMediaUrls(tabId).length;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    }

    const manifestEnded = await hasEndedManifest(observedMediaUrls(tabId));
    const idleFor = Date.now() - lastChangeAt;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const activeLabel = state?.activePlayback ? "playing" : state?.hasPlayableMedia ? "idle/paused" : "scanning";
    progress(requestId, 25, `Collecting chunks: ${count} detected (${activeLabel}, ${elapsed}s).`);

    if (manifestEnded && count > 0) {
      progress(requestId, 29, `Stream end marker found. ${count} chunks detected.`);
      break;
    }
    if (state?.allEnded && count > 0) {
      progress(requestId, 29, `Playback ended. ${count} chunks detected.`);
      break;
    }
    if (!state?.activePlayback && count > 0 && sawActivePlayback && idleFor >= mediaCaptureIdleMs) {
      progress(requestId, 29, `Playback stopped and chunk stream is idle. ${count} chunks detected.`);
      break;
    }
    if (!state?.activePlayback && count > 0 && !sawPlayableMedia && idleFor >= mediaCaptureIdleMs) {
      progress(requestId, 29, `Chunk stream is idle. ${count} chunks detected.`);
      break;
    }
    if (!state?.activePlayback && count > 0 && idleFor >= mediaCapturePausedIdleMs) {
      progress(requestId, 29, `Media is paused/idle. ${count} chunks detected.`);
      break;
    }
    await sleep(count ? mediaCapturePollMs : mediaSettleMs);
  }
}

async function collectMediaState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "collectMediaState" });
    return response?.ok ? response.state : {};
  } catch {
    return {};
  }
}

async function hasEndedManifest(urls) {
  const manifest = urls.find((url) => /\.(m3u8|mpd)(\?|#|$)/i.test(String(url || "")));
  if (!manifest) return false;
  try {
    const response = await fetch(manifest, { credentials: "include", cache: "no-store" });
    if (!response.ok) return false;
    const text = await response.text();
    return /#EXT-X-ENDLIST|<\/MPD>/i.test(text);
  } catch {
    return false;
  }
}

async function postClip(payload) {
  const settings = await getSettings();
  const vault = settings.vault || await firstVault(settings.serverUrl);
  if (!vault) throw new Error("Select a vault in the LLM Wiki Agent Clipper popup.");
  const response = await fetch(`${settings.serverUrl.replace(/\/+$/, "")}/api/clip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, vault })
  });
  const raw = await response.text();
  const data = parseJson(raw);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("The running LLM Wiki Agent app does not include the browser clip endpoint yet. Rebuild/reinstall the app, then restart it.");
    }
    throw new Error(data.error || raw.replace(/\s+/g, " ").trim().slice(0, 240) || "The LLM Wiki Agent rejected the clip.");
  }
  return data;
}

function summarizePreparedClip(payload) {
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const summary = mediaSummary(media);
  return {
    title: payload?.title || "Untitled clip",
    url: payload?.url || "",
    captureType: payload?.captureType || "page",
    textLength: String(payload?.text || "").length,
    media,
    summary
  };
}

function mediaSummary(media) {
  const total = Array.isArray(media) ? media.length : 0;
  const downloaded = Array.isArray(media) ? media.filter((item) => item?.dataUrl || item?.downloadStatus === "downloaded").length : 0;
  const urlOnly = Array.isArray(media) ? media.filter((item) => item?.url && !item?.dataUrl).length : 0;
  const failed = Array.isArray(media) ? media.filter((item) => item?.downloadError).length : 0;
  return { total, downloaded, urlOnly, failed };
}

function progress(requestId, percent, message) {
  if (!requestId) return;
  chrome.runtime.sendMessage({
    type: "clipProgress",
    requestId,
    percent,
    message
  }).catch?.(() => {});
}

async function firstVault(serverUrl) {
  const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/vaults`);
  const data = await response.json();
  return data?.vaults?.[0]?.name || "";
}

function getSettings() {
  return chrome.storage.sync.get({
    serverUrl: defaultServerUrl,
    vault: ""
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function approximateDataUrlBytes(dataUrl) {
  const comma = String(dataUrl || "").indexOf(",");
  const body = comma >= 0 ? String(dataUrl).slice(comma + 1) : String(dataUrl || "");
  return Math.floor((body.length * 3) / 4);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function filenameFromUrl(value) {
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop() || "");
  } catch {
    return "";
  }
}

function looksLikeMedia(url) {
  return /\.(png|jpe?g|gif|webp|svg|pdf|mp3|wav|m4a|aiff|mp4|mov|m4v|m4s|m3u8|mpd|webm|aac)(\?|#|$)/i.test(String(url || ""));
}

function isLikelyStreamingMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  const normalized = url.toLowerCase();
  if (/\/sdk(\.|-|\/)|sdk\.latest\.js|\.js(\?|#|$)|\.css(\?|#|$)/.test(normalized)) return false;
  return looksLikeMedia(normalized) ||
    /\.(m4s|m3u8|mpd|webm|aac)(\?|#|$)/.test(normalized) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(normalized) ||
    /\/seg[_-]?\d+/.test(normalized) ||
    (normalized.includes("cloudflarestream.com") && /(manifest|playlist|chunk|segment|\.m3u8|\.mpd|\.m4s|\/video|\/audio)/.test(normalized)) ||
    normalized.includes("videoplayback");
}

function mediaKind(url) {
  const text = String(url || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/.test(text)) return "image";
  if (/\.(mp3|wav|m4a|aiff)(\?|#|$)/.test(text)) return "audio";
  if (/\.(mp4|mov|m4v)(\?|#|$)/.test(text)) return "video";
  if (/\.pdf(\?|#|$)/.test(text)) return "pdf";
  return "media";
}

function mediaPriority(url) {
  const text = String(url || "").toLowerCase();
  if (/\.(m4s|m3u8|mpd)(\?|#|$)|\/(audio|video)\/\d+\/(init|seg_|chunk_)|\/seg[_-]?\d+|videoplayback/.test(text)) return 100;
  if (/\.(mp4|mov|m4v|webm)(\?|#|$)/.test(text)) return 90;
  if (/\.(mp3|wav|m4a|aiff|aac)(\?|#|$)/.test(text)) return 80;
  if (/\.pdf(\?|#|$)/.test(text)) return 70;
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/.test(text)) return 50;
  if (/\.svg(\?|#|$)/.test(text)) return 20;
  return 10;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (chrome.webRequest?.onCompleted) {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0 || !isLikelyStreamingMediaUrl(details.url)) return;
      rememberMediaUrls(details.tabId, details.documentUrl || details.initiator || "", [details.url]);
    },
    { urls: ["http://*/*", "https://*/*"] }
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
});
