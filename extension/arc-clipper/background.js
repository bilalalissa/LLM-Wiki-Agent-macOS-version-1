const defaultServerUrl = "http://127.0.0.1:8789";
const maxInlineTransferChars = 180 * 1024 * 1024;
const maxBrowserMediaBytes = 50 * 1024 * 1024;
const maxManifestExpansionItems = 12000;
const maxManifestDepth = 3;
const mediaDownloadConcurrency = 6;
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
    progress(requestId, 25, "Requesting stream manifests directly from source...");
    await collectMediaState(tab.id);
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
  const expandedItems = await expandStreamManifests(preparedItems, requestId);
  const mediaItems = uniqueMediaItems(expandedItems).sort((a, b) => mediaPriority(b.url || b.src) - mediaPriority(a.url || a.src));
  const downloadedMedia = await downloadMediaItems(mediaItems, requestId);
  const media = [];
  let inlineChars = 0;
  for (let index = 0; index < downloadedMedia.length; index += 1) {
    let next = downloadedMedia[index];
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

async function downloadMediaItems(items, requestId = "") {
  const media = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(mediaDownloadConcurrency, Math.max(items.length, 1));
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item?.dataUrl) {
        media[index] = {
          ...item,
          downloadStatus: "downloaded",
          downloadBytes: approximateDataUrlBytes(item.dataUrl),
          downloadMethod: "page-data"
        };
      } else {
        media[index] = await mediaPayload(item.url || item.src, item.alt || item.title || "", item);
      }
      completed += 1;
      if (requestId) {
        const percent = items.length
          ? 30 + Math.round((completed / items.length) * 60)
          : 90;
        progress(requestId, percent, `Checked media ${completed} of ${items.length}.`);
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return media.filter(Boolean);
}

async function mediaPayload(url, alt, source = {}) {
  const base = {
    url,
    alt,
    type: mediaKind(url),
    filename: filenameFromUrl(url),
    streamManifestUrl: source.streamManifestUrl || "",
    streamGroup: source.streamGroup || ""
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
      downloadMethod: source.downloadMethod || "browser-fetch"
    };
  } catch (error) {
    return { ...base, downloadStatus: "url-only", downloadError: `${error.name || "Error"}: ${error.message || "Browser fetch failed"}` };
  }
}

async function expandStreamManifests(items, requestId = "") {
  const result = [...items];
  const manifests = items
    .map((item) => item?.url || item?.src || "")
    .filter((url) => isStreamManifestUrl(url));
  if (!manifests.length) return result;

  const seen = new Set(result.map((item) => item?.url || item?.src || "").filter(Boolean));
  for (const [index, manifestUrl] of manifests.entries()) {
    if (requestId) {
      progress(requestId, 26, `Requesting stream manifest ${index + 1} of ${manifests.length} directly from source...`);
    }
    const expanded = await expandManifestUrl(manifestUrl, {
      depth: 0,
      visited: new Set(),
      remaining: maxManifestExpansionItems - result.length
    });
    for (const mediaUrl of expanded) {
      if (!mediaUrl || seen.has(mediaUrl)) continue;
      seen.add(mediaUrl);
      result.push({
        url: mediaUrl,
        alt: "Stream part from manifest",
        type: mediaKind(mediaUrl),
        streamManifestUrl: manifestUrl,
        streamGroup: filenameFromUrl(manifestUrl) || "manifest",
        downloadMethod: "manifest-direct"
      });
      if (result.length >= maxManifestExpansionItems) break;
    }
    if (result.length >= maxManifestExpansionItems) break;
  }
  if (requestId) {
    const added = result.length - items.length;
    const capped = result.length >= maxManifestExpansionItems;
    progress(requestId, 29, added
      ? `Requested ${added} stream parts directly from manifests${capped ? ` (stopped at safety cap ${maxManifestExpansionItems})` : ""}.`
      : "No stream parts were exposed by detected manifests.");
  }
  return result;
}

async function expandManifestUrl(manifestUrl, state) {
  if (!manifestUrl || state.depth > maxManifestDepth || state.remaining <= 0 || state.visited.has(manifestUrl)) return [];
  state.visited.add(manifestUrl);
  try {
    const response = await fetch(manifestUrl, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer-when-downgrade"
    });
    if (!response.ok) return [];
    const text = await response.text();
    if (/^\s*#EXTM3U/im.test(text) || /\.m3u8(\?|#|$)/i.test(manifestUrl)) {
      return expandHlsManifest(text, manifestUrl, state);
    }
    if (/<MPD[\s>]/i.test(text) || /\.mpd(\?|#|$)/i.test(manifestUrl)) {
      return expandDashManifest(text, manifestUrl, state);
    }
    return [];
  } catch {
    return [];
  }
}

async function expandHlsManifest(text, manifestUrl, state) {
  const found = [];
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isMediaPlaylist = lines.some((line) => /^#EXTINF\b|^#EXT-X-TARGETDURATION\b|^#EXT-X-MAP\b|^#EXT-X-BYTERANGE\b/i.test(line));
  for (let index = 0; index < lines.length && found.length < state.remaining; index += 1) {
    const line = lines[index];
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
      const uri = attrValue(line, "URI");
      if (uri) {
        found.push(...await expandManifestUrl(absoluteUrlFrom(uri, manifestUrl), { ...state, depth: state.depth + 1, remaining: state.remaining - found.length }));
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const uri = attrValue(line, "URI");
      if (uri) found.push(absoluteUrlFrom(uri, manifestUrl));
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA")) {
      const uri = attrValue(line, "URI");
      if (uri) {
        const mediaPlaylist = absoluteUrlFrom(uri, manifestUrl);
        if (isStreamManifestUrl(mediaPlaylist)) {
          found.push(...await expandManifestUrl(mediaPlaylist, { ...state, depth: state.depth + 1, remaining: state.remaining - found.length }));
        }
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    const url = absoluteUrlFrom(line, manifestUrl);
    if (!url) continue;
    if (!isMediaPlaylist || isStreamManifestUrl(url)) {
      found.push(...await expandManifestUrl(url, { ...state, depth: state.depth + 1, remaining: state.remaining - found.length }));
    } else {
      found.push(url);
    }
  }
  return found.slice(0, state.remaining);
}

async function expandDashManifest(text, manifestUrl, state) {
  const found = [];
  const xml = String(text || "");
  for (const url of explicitDashUrls(xml, manifestUrl)) {
    if (found.length >= state.remaining) break;
    found.push(url);
  }
  if (found.length < state.remaining) {
    found.push(...expandDashSegmentTemplates(xml, manifestUrl, state.remaining - found.length));
  }
  return found.slice(0, state.remaining);
}

function explicitDashUrls(xml, manifestUrl) {
  const urls = [];
  const patterns = [
    /<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi,
    /<SegmentURL[^>]*\smedia=["']([^"']+)["'][^>]*>/gi,
    /<Initialization[^>]*\ssourceURL=["']([^"']+)["'][^>]*>/gi,
    /["']([^"']+\.(?:m4s|mp4|webm|aac|ts|cmfv|cmfa)(?:\?[^"']*)?)["']/gi
  ];
  for (const pattern of patterns) {
    for (const match of xml.matchAll(pattern)) {
      const url = absoluteUrlFrom(decodeXml(match[1]), manifestUrl);
      if (url && isLikelyStreamingMediaUrl(url)) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

function expandDashSegmentTemplates(xml, manifestUrl, limit) {
  const urls = [];
  const representationIds = [...xml.matchAll(/<Representation\b[^>]*\sid=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => decodeXml(match[1]))
    .filter(Boolean);
  const ids = representationIds.length ? representationIds.slice(0, 8) : [""];
  for (const match of xml.matchAll(/<SegmentTemplate\b([^>]*)>/gi)) {
    const attrs = match[1] || "";
    const media = attrValue(attrs, "media");
    const init = attrValue(attrs, "initialization");
    if (!media && !init) continue;
    const start = Number(attrValue(attrs, "startNumber") || 1) || 1;
    const count = dashSegmentCount(xml, match.index);
    for (const representationId of ids) {
      if (init && urls.length < limit) {
        urls.push(resolveDashTemplate(init, manifestUrl, representationId, start));
      }
      for (let number = start; number < start + count && urls.length < limit; number += 1) {
        urls.push(resolveDashTemplate(media, manifestUrl, representationId, number));
      }
      if (urls.length >= limit) break;
    }
    if (urls.length >= limit) break;
  }
  return [...new Set(urls.filter((url) => url && isLikelyStreamingMediaUrl(url)))].slice(0, limit);
}

function dashSegmentCount(xml, index = 0) {
  const tail = xml.slice(index, index + 20000);
  const timeline = tail.match(/<SegmentTimeline\b[\s\S]*?<\/SegmentTimeline>/i)?.[0] || "";
  if (!timeline) {
    const attrs = tail.match(/<SegmentTemplate\b([^>]*)>/i)?.[1] || "";
    const duration = Number(attrValue(attrs, "duration") || 0);
    const timescale = Number(attrValue(attrs, "timescale") || 1) || 1;
    const presentationSeconds = parseIsoDurationSeconds(attrValue(xml, "mediaPresentationDuration"));
    if (duration > 0 && presentationSeconds > 0) {
      return Math.min(Math.max(Math.ceil(presentationSeconds / (duration / timescale)), 1), maxManifestExpansionItems);
    }
    return maxManifestExpansionItems;
  }
  let total = 0;
  for (const match of timeline.matchAll(/<S\b([^>]*)\/?>/gi)) {
    const repeat = Number(attrValue(match[1] || "", "r") || 0);
    total += Math.max(1, repeat + 1);
    if (total >= maxManifestExpansionItems) break;
  }
  return Math.min(Math.max(total, 1), maxManifestExpansionItems);
}

function parseIsoDurationSeconds(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(value || ""));
  if (!match) return 0;
  const [, years, months, days, hours, minutes, seconds] = match.map((item) => Number(item || 0));
  return (years * 365 * 24 * 60 * 60) +
    (months * 30 * 24 * 60 * 60) +
    (days * 24 * 60 * 60) +
    (hours * 60 * 60) +
    (minutes * 60) +
    seconds;
}

function resolveDashTemplate(template, manifestUrl, representationId, number) {
  if (!template) return "";
  const value = template
    .replace(/\$RepresentationID\$/g, representationId || "")
    .replace(/\$Number(?:%0\d+d)?\$/g, String(number))
    .replace(/\$Time(?:%0\d+d)?\$/g, String(number));
  return absoluteUrlFrom(value, manifestUrl);
}

function attrValue(text, name) {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
  return decodeXml(String(text || "").match(pattern)?.[1] || "");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absoluteUrlFrom(value, base) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value, base).href;
  } catch {
    return "";
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

async function collectMediaState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "collectMediaState" });
    return response?.ok ? response.state : {};
  } catch {
    return {};
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
  return /\.(png|jpe?g|gif|webp|svg|pdf|mp3|wav|m4a|aiff|mp4|mov|m4v|m4s|m3u8|mpd|webm|aac|ts|cmfv|cmfa)(\?|#|$)/i.test(String(url || ""));
}

function isStreamManifestUrl(url) {
  return /\.(m3u8|mpd)(\?|#|$)/i.test(String(url || ""));
}

function isLikelyStreamingMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  const normalized = url.toLowerCase();
  if (/\/sdk(\.|-|\/)|sdk\.latest\.js|\.js(\?|#|$)|\.css(\?|#|$)/.test(normalized)) return false;
  return looksLikeMedia(normalized) ||
    /\.(m4s|m3u8|mpd|webm|aac|ts|cmfv|cmfa)(\?|#|$)/.test(normalized) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(normalized) ||
    /\/seg[_-]?\d+/.test(normalized) ||
    (normalized.includes("cloudflarestream.com") && /(manifest|playlist|chunk|segment|\.m3u8|\.mpd|\.m4s|\/video|\/audio)/.test(normalized)) ||
    normalized.includes("videoplayback");
}

function mediaKind(url) {
  const text = String(url || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/.test(text)) return "image";
  if (/\.(mp3|wav|m4a|aiff)(\?|#|$)/.test(text)) return "audio";
  if (/\.(mp4|mov|m4v|ts|m4s|cmfv|cmfa)(\?|#|$)/.test(text)) return "video";
  if (/\.pdf(\?|#|$)/.test(text)) return "pdf";
  return "media";
}

function mediaPriority(url) {
  const text = String(url || "").toLowerCase();
  if (/\.(m4s|m3u8|mpd|ts|cmfv|cmfa)(\?|#|$)|\/(audio|video)\/\d+\/(init|seg_|chunk_)|\/seg[_-]?\d+|videoplayback/.test(text)) return 100;
  if (/\.(mp4|mov|m4v|webm)(\?|#|$)/.test(text)) return 90;
  if (/\.(mp3|wav|m4a|aiff|aac)(\?|#|$)/.test(text)) return 80;
  if (/\.pdf(\?|#|$)/.test(text)) return 70;
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/.test(text)) return 50;
  if (/\.svg(\?|#|$)/.test(text)) return 20;
  return 10;
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
