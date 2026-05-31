const defaultServerUrl = "http://127.0.0.1:8789";
const maxInlineTransferChars = 180 * 1024 * 1024;
const maxBrowserMediaBytes = 50 * 1024 * 1024;
const maxManifestExpansionItems = 12000;
const maxManifestDepth = 3;
const mediaDownloadConcurrency = 6;
const mediaByTab = new Map();
let preparedClip = null;
let clipState = {
  status: "idle",
  requestId: "",
  percent: 0,
  message: "Ready.",
  result: null,
  savedResult: null,
  error: "",
  updatedAt: Date.now()
};

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
    updateClipState({
      status: "preparing",
      requestId: message.requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      percent: 2,
      message: "Starting...",
      result: null,
      savedResult: null,
      error: ""
    });
    preparePopupClip(message.captureType, message.requestId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        updateClipState({ status: "error", percent: 0, message: error.message, error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === "submitPreparedClip") {
    updateClipState({
      status: "submitting",
      percent: 10,
      message: "Submitting to vault...",
      error: ""
    });
    submitPreparedClip(message.updates || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        updateClipState({ status: "error", percent: 0, message: error.message, error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === "getClipState") {
    getClipState().then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.type === "clearClipState") {
    preparedClip = null;
    updateClipState({
      status: "idle",
      requestId: "",
      percent: 0,
      message: "Ready.",
      result: null,
      savedResult: null,
      error: ""
    }).then(() => sendResponse({ ok: true }));
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
  const result = summarizePreparedClip(payload);
  updateClipState({
    status: "ready",
    requestId,
    percent: 100,
    message: "Clip is ready to review.",
    result,
    error: ""
  });
  return result;
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
  preparedClip = {
    ...preparedClip,
    ...(title ? { title } : {}),
    tags: normalizeClipTags(updates.tags)
  };
  const result = await postClip(preparedClip);
  preparedClip = null;
  updateClipState({
    status: "saved",
    percent: 100,
    message: `Saved to ${result.file}`,
    savedResult: result,
    error: ""
  });
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
  const streamReport = await inspectStreamManifests(preparedItems, requestId);
  const pageVideo = pageVideoRequest(payload);
  if (pageVideo) {
    if (requestId) progress(requestId, 90, "Prepared one page-video request; chunk assets are excluded.");
    return {
      ...payload,
      media: [],
      singleVideoRequest: pageVideo,
      text: [
        payload.text || `Media exported from ${payload.url || "this page"}`,
        "",
        "Single video capture:",
        `- Provider: ${pageVideo.provider}`,
        `- Source URL: ${pageVideo.url}`,
        "- The extension did not upload detected chunks, storyboard images, thumbnails, or sub-videos.",
        "- The local agent will download one merged video file and subtitle transcript when yt-dlp is available.",
        "",
        streamReportText(streamReport)
      ].filter(Boolean).join("\n")
    };
  }
  const mediaItems = uniqueMediaItems(preparedItems.filter((item) => !isStreamReferenceItem(item)))
    .sort((a, b) => mediaPriority(b.url || b.src) - mediaPriority(a.url || a.src));
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
        streamReportText(streamReport),
        `Detected non-stream media items: ${summary.total}`,
        `Downloaded non-stream media items before submit: ${summary.downloaded}`,
        `URL-only non-stream media items: ${summary.urlOnly}`,
        summary.failed ? `Failed non-stream media downloads: ${summary.failed}` : ""
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

async function inspectStreamManifests(items, requestId = "") {
  const manifests = items
    .map((item) => item?.url || item?.src || "")
    .filter((url) => isStreamManifestUrl(url));
  if (!manifests.length) return [];

  const reports = [];
  const seenManifests = new Set();
  for (const [index, manifestUrl] of manifests.entries()) {
    if (seenManifests.has(manifestUrl)) continue;
    seenManifests.add(manifestUrl);
    if (requestId) {
      progress(requestId, 26, `Inspecting stream manifest ${index + 1} of ${manifests.length} directly from source...`);
    }
    const expanded = await expandManifestUrl(manifestUrl, {
      depth: 0,
      visited: new Set(),
      remaining: maxManifestExpansionItems
    });
    reports.push({
      manifestUrl,
      chunkCount: new Set(expanded.filter(Boolean)).size,
      capped: expanded.length >= maxManifestExpansionItems
    });
  }
  if (requestId) {
    const chunks = reports.reduce((sum, item) => sum + item.chunkCount, 0);
    progress(requestId, 29, chunks
      ? `Found ${chunks} stream parts in source manifests; sending one clip summary without chunk files.`
      : "No stream parts were exposed by detected manifests.");
  }
  return reports;
}

function streamReportText(reports) {
  if (!reports.length) return "";
  const lines = [
    "Stream source inspection:",
    "- Chunks are not uploaded to the agent or saved into Obsidian vault assets.",
    "- The clip stores source manifest metadata only."
  ];
  for (const report of reports) {
    lines.push(`- Manifest: ${report.manifestUrl}`);
    lines.push(`  - Source chunks listed by manifest: ${report.chunkCount}${report.capped ? ` (at safety cap ${maxManifestExpansionItems})` : ""}`);
  }
  return lines.join("\n");
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
    tags: Array.isArray(payload?.tags) ? payload.tags : [],
    url: payload?.url || "",
    captureType: payload?.captureType || "page",
    textLength: String(payload?.text || "").length,
    media: media.map((item) => {
      const next = { ...item };
      delete next.dataUrl;
      return next;
    }),
    singleVideoRequest: payload?.singleVideoRequest || null,
    summary
  };
}

function normalizeClipTags(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const tags = [];
  for (const item of values) {
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

function mediaSummary(media) {
  const total = Array.isArray(media) ? media.length : 0;
  const downloaded = Array.isArray(media) ? media.filter((item) => item?.dataUrl || item?.downloadStatus === "downloaded").length : 0;
  const urlOnly = Array.isArray(media) ? media.filter((item) => item?.url && !item?.dataUrl).length : 0;
  const failed = Array.isArray(media) ? media.filter((item) => item?.downloadError).length : 0;
  return { total, downloaded, urlOnly, failed };
}

function progress(requestId, percent, message) {
  if (!requestId) return;
  updateClipState({
    requestId,
    percent,
    message,
    status: clipState.status === "submitting" ? "submitting" : "preparing"
  });
  chrome.runtime.sendMessage({
    type: "clipProgress",
    requestId,
    percent,
    message
  }).catch?.(() => {});
}

async function getClipState() {
  const stored = await chrome.storage.local.get({ clipState: null });
  if (stored.clipState && stored.clipState.updatedAt > clipState.updatedAt) {
    clipState = stored.clipState;
  }
  return clipState;
}

async function updateClipState(next) {
  clipState = {
    ...clipState,
    ...next,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ clipState });
  updateBadge(clipState);
  chrome.runtime.sendMessage({
    type: "clipState",
    state: clipState
  }).catch?.(() => {});
}

function updateBadge(state) {
  const status = state?.status || "idle";
  const text = status === "preparing" ? "..." :
    status === "submitting" ? "UP" :
    status === "ready" ? "OK" :
    status === "saved" ? "✓" :
    status === "error" ? "!" : "";
  chrome.action.setBadgeText({ text }).catch?.(() => {});
  const color = status === "error" ? "#dc2626" :
    status === "ready" || status === "saved" ? "#15803d" :
    status === "preparing" || status === "submitting" ? "#8a5a19" : "#6b7280";
  chrome.action.setBadgeBackgroundColor({ color }).catch?.(() => {});
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

function isStreamReferenceItem(item) {
  const url = String(item?.url || item?.src || "");
  return Boolean(item?.streamManifestUrl) || isStreamManifestUrl(url) || isLikelyStreamingSegmentUrl(url);
}

function isLikelyStreamingSegmentUrl(url) {
  const normalized = String(url || "").toLowerCase();
  return /\.(m4s|ts|cmfv|cmfa)(\?|#|$)/.test(normalized) ||
    /(^|\/\/|\.)(googlevideo\.com|youtube\.com)\//.test(normalized) && /videoplayback|\/api\/manifest|\/ptracking/.test(normalized) ||
    /i\.ytimg\.com\/sb\/|\/storyboard/.test(normalized) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(normalized) ||
    /\/seg[_-]?\d+/.test(normalized) ||
    /(^|\b)(init|seg[_-]?\d+|chunk[_-]?\d+)[^/\s]*\.(mp4|ts|m4s)(\?|#|\s|$)/.test(normalized) ||
    (normalized.includes("cloudflarestream.com") && /(chunk|segment|seg_|\.m4s|\.ts|\/video\/|\/audio\/)/.test(normalized));
}

function isLikelyStreamingMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  const normalized = url.toLowerCase();
  if (/\/sdk(\.|-|\/)|sdk\.latest\.js|\.js(\?|#|$)|\.css(\?|#|$)/.test(normalized)) return false;
  return looksLikeMedia(normalized) ||
    /\.(m4s|m3u8|mpd|webm|aac|ts|cmfv|cmfa)(\?|#|$)/.test(normalized) ||
    /\/(audio|video)\/\d+\/(init|seg_|chunk_)/.test(normalized) ||
    /\/seg[_-]?\d+/.test(normalized) ||
    /i\.ytimg\.com\/sb\/|\/storyboard/.test(normalized) ||
    (normalized.includes("cloudflarestream.com") && /(manifest|playlist|chunk|segment|\.m3u8|\.mpd|\.m4s|\/video|\/audio)/.test(normalized)) ||
    normalized.includes("videoplayback");
}

function pageVideoRequest(payload) {
  if (payload?.captureType !== "media") return null;
  const pageUrl = String(payload?.url || "");
  if (!isYouTubePageUrl(pageUrl)) return null;
  return {
    provider: "youtube",
    url: pageUrl
  };
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
