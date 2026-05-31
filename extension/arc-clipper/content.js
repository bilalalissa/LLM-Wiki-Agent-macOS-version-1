const observedMediaUrls = new Set();
let mediaScanTimer = null;
let mediaScanInterval = null;
let mediaMutationObserver = null;
let mediaPerformanceObserver = null;
let extensionContextValid = true;

function collectClip(captureType) {
  if (captureType === "selection") return collectSelection();
  if (captureType === "media") return collectPageMedia();
  return collectPage();
}

function collectPage() {
  return {
    captureType: "page",
    title: document.title || location.hostname,
    url: location.href,
    text: document.body?.innerText || "",
    html: document.documentElement?.outerHTML?.slice(0, 150000) || "",
    media: collectMediaCandidates()
  };
}

function collectSelection() {
  const selection = window.getSelection();
  const text = selection?.toString() || "";
  return {
    captureType: "selection",
    title: selectionTitle(text),
    url: location.href,
    text,
    html: selectedHtml(selection),
    media: mediaNearSelection(selection)
  };
}

function collectPageMedia() {
  return {
    captureType: "media",
    title: `Media from ${document.title || location.hostname}`,
    url: location.href,
    text: `Media exported from ${location.href}`,
    html: "",
    media: collectMediaCandidates()
  };
}

function collectMediaCandidates() {
  const items = [];
  for (const image of Array.from(document.images || [])) {
    const url = image.currentSrc || image.src;
    if (!url) continue;
    items.push({
      url,
      alt: image.alt || image.title || "",
      type: "image"
    });
  }
  for (const element of Array.from(document.querySelectorAll("video, video source, audio, audio source, a[href]"))) {
    for (const url of mediaUrlsFromElement(element)) {
      if (!url || !looksLikeMedia(url)) continue;
      items.push({
        url,
        alt: element.getAttribute("aria-label") || element.title || element.textContent?.trim() || "",
        type: mediaKind(url)
      });
    }
  }
  for (const url of observedMediaUrls) {
    items.push({
      url,
      alt: "",
      type: mediaKind(url)
    });
  }
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).sort((a, b) => mediaPriority(b.url) - mediaPriority(a.url));
}

function mediaNearSelection(selection) {
  if (!selection || !selection.rangeCount) return [];
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  if (!element) return [];
  return Array.from(element.querySelectorAll?.("img, video, audio") || [])
    .flatMap((item) => mediaUrlsFromElement(item).map((url) => ({
      url,
      alt: item.alt || item.title || "",
      type: item.tagName.toLowerCase()
    })))
    .filter((item) => item.url)
    .slice(0, 10);
}

async function attachInlineData(media) {
  const items = Array.isArray(media) ? media : [];
  const enriched = [];
  for (const item of items) {
    if (!item?.url || item.dataUrl) {
      enriched.push(item);
      continue;
    }
    if (!item.url.startsWith("blob:") && !item.url.startsWith("data:")) {
      enriched.push(item);
      continue;
    }
    enriched.push({ ...item, dataUrl: await urlToDataUrl(item.url).catch(() => "") });
  }
  return enriched;
}

async function urlToDataUrl(url) {
  if (url.startsWith("data:")) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > 15 * 1024 * 1024) throw new Error("Media is too large for inline transfer.");
  return blobToDataUrl(blob);
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

function selectedHtml(selection) {
  if (!selection || !selection.rangeCount) return "";
  const wrapper = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index += 1) {
    wrapper.append(selection.getRangeAt(index).cloneContents());
  }
  return wrapper.innerHTML;
}

function selectionTitle(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 90) : (document.title || location.hostname);
}

function looksLikeMedia(url) {
  return /\.(png|jpe?g|gif|webp|svg|pdf|mp3|wav|m4a|aiff|mp4|mov|m4v|m4s|m3u8|mpd|webm|aac)(\?|#|$)/i.test(String(url || ""));
}

function mediaKind(url) {
  const text = String(url || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/.test(text)) return "image";
  if (/\.(mp3|wav|m4a|aiff)(\?|#|$)/.test(text)) return "audio";
  if (/\.(mp4|mov|m4v)(\?|#|$)/.test(text)) return "video";
  if (/\.pdf(\?|#|$)/.test(text)) return "pdf";
  return "media";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collectMediaState") {
    scanMediaElements();
    scanPerformanceEntries();
    sendResponse({ ok: true, state: mediaCaptureState() });
    return false;
  }
  if (message?.type !== "collectClip") return false;
  Promise.resolve()
    .then(async () => {
      const payload = collectClip(message.captureType);
      payload.media = await attachInlineData(payload.media);
      sendResponse({ ok: true, payload });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function mediaCaptureState() {
  const elements = Array.from(document.querySelectorAll?.("video, audio") || []);
  const playable = elements.map((element) => ({
    tag: element.tagName.toLowerCase(),
    currentTime: Number(element.currentTime || 0),
    duration: Number.isFinite(element.duration) ? Number(element.duration) : null,
    ended: Boolean(element.ended),
    paused: Boolean(element.paused),
    readyState: Number(element.readyState || 0),
    src: element.currentSrc || element.src || ""
  }));
  return {
    pageURL: location.href,
    observedCount: observedMediaUrls.size,
    observedMediaURLs: Array.from(observedMediaUrls),
    hasPlayableMedia: playable.length > 0,
    activePlayback: playable.some((item) => !item.paused && !item.ended),
    anyEnded: playable.some((item) => item.ended),
    allEnded: playable.length > 0 && playable.every((item) => item.ended),
    playable
  };
}

function mediaUrlsFromElement(element) {
  const urls = [
    element.currentSrc,
    element.src,
    element.href,
    element.getAttribute?.("src"),
    element.getAttribute?.("href"),
    element.getAttribute?.("poster"),
    element.getAttribute?.("data-src"),
    element.getAttribute?.("data-url"),
    element.getAttribute?.("data-video-url"),
    element.getAttribute?.("data-audio-url")
  ];
  return urls.map(absoluteUrl).filter(Boolean);
}

function absoluteUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value, document.baseURI).href;
  } catch {
    return "";
  }
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

function rememberMediaUrls(urls) {
  if (!extensionContextAvailable()) return;
  const next = [];
  for (const raw of urls) {
    const url = absoluteUrl(raw);
    if (!url || observedMediaUrls.has(url) || !isLikelyStreamingMediaUrl(url)) continue;
    observedMediaUrls.add(url);
    next.push(url);
  }
  if (!next.length) return;
  sendObservedMediaMessage({
    type: "llmwiki:observed-media",
    pageURL: location.href,
    mediaURLs: next
  });
}

function scanMediaElements() {
  if (!extensionContextAvailable()) return;
  const urls = [];
  for (const element of document.querySelectorAll?.("img, video, audio, source, a[href]") || []) {
    urls.push(...mediaUrlsFromElement(element));
  }
  rememberMediaUrls(urls);
}

function scanPerformanceEntries() {
  if (!extensionContextAvailable()) return;
  const entries = performance.getEntriesByType?.("resource") || [];
  rememberMediaUrls(entries.map((entry) => entry.name));
}

function scheduleMediaScan() {
  if (!extensionContextAvailable()) return;
  if (mediaScanTimer) return;
  mediaScanTimer = setTimeout(() => {
    mediaScanTimer = null;
    scanMediaElements();
    scanPerformanceEntries();
  }, 500);
}

function installMediaListeners() {
  if (!extensionContextAvailable()) return;
  for (const element of document.querySelectorAll?.("video, audio") || []) {
    if (element.dataset.llmWikiMediaObserved === "true") continue;
    element.dataset.llmWikiMediaObserved = "true";
    for (const eventName of ["loadstart", "loadedmetadata", "canplay", "play", "playing", "progress", "timeupdate"]) {
      element.addEventListener(eventName, scheduleMediaScan, true);
    }
  }
}

if (document.documentElement) {
  mediaMutationObserver = new MutationObserver(() => {
    installMediaListeners();
    scheduleMediaScan();
  });
  mediaMutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "poster", "data-src", "data-url", "data-video-url", "data-audio-url"]
  });
}

if (typeof PerformanceObserver !== "undefined") {
  try {
    mediaPerformanceObserver = new PerformanceObserver((list) => {
      if (!extensionContextAvailable()) return;
      rememberMediaUrls(list.getEntries().map((entry) => entry.name));
    });
    mediaPerformanceObserver.observe({ entryTypes: ["resource"] });
  } catch {
    // Periodic scans below still cover older browser behavior.
  }
}

installMediaListeners();
scheduleMediaScan();
mediaScanInterval = setInterval(() => {
  if (!extensionContextAvailable()) return;
  installMediaListeners();
  scanMediaElements();
  scanPerformanceEntries();
}, 1500);

function sendObservedMediaMessage(message) {
  if (!extensionContextAvailable()) return;
  try {
    const result = chrome.runtime.sendMessage(message);
    result?.catch?.(() => {
      if (!extensionContextAvailable()) invalidateExtensionContext();
    });
  } catch {
    invalidateExtensionContext();
  }
}

function extensionContextAvailable() {
  if (!extensionContextValid) return false;
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      invalidateExtensionContext();
      return false;
    }
    return true;
  } catch {
    invalidateExtensionContext();
    return false;
  }
}

function invalidateExtensionContext() {
  extensionContextValid = false;
  if (mediaScanTimer) {
    clearTimeout(mediaScanTimer);
    mediaScanTimer = null;
  }
  if (mediaScanInterval) {
    clearInterval(mediaScanInterval);
    mediaScanInterval = null;
  }
  mediaMutationObserver?.disconnect?.();
  mediaPerformanceObserver?.disconnect?.();
}
