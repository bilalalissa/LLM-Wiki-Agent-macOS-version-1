import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../src/config.mjs";
import { listVaults, vaultName } from "../src/vaults.mjs";

const config = getConfig();
const results = [];

for (const vaultPath of listVaults(config.vaultsRoot)) {
  for (const root of [path.join(vaultPath, "raw", "input"), path.join(vaultPath, "raw", "processed")]) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root).filter((item) => item.endsWith(".md"))) {
      const before = fs.readFileSync(file, "utf8");
      const after = compactBrowserStreamMedia(before);
      if (after !== before) {
        fs.writeFileSync(file, after, "utf8");
        results.push(`${vaultName(vaultPath)}:${path.relative(vaultPath, file).replace(/\\/g, "/")}`);
      }
    }
  }
}

for (const item of results) console.log(item);
console.log(`Compacted ${results.length} browser stream clip file${results.length === 1 ? "" : "s"}.`);

function compactBrowserStreamMedia(markdown) {
  if (!/^source:\s*arc-extension\s*$/m.test(markdown)) return markdown;
  if (!/^capture_type:\s*media\s*$/m.test(markdown)) return markdown;

  const mediaMatch = markdown.match(/\n## Media\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!mediaMatch) return markdown;

  const block = mediaMatch[1];
  const streamRefs = [...block.matchAll(/!\[\[(raw\/assets\/browser-clips\/[^\]]*(?:seg[_-]?\d+|chunk[_-]?\d+|init|\.mpd|\.m3u8|\.m4s)[^\]]*)\]\]/gi)]
    .map((match) => match[1]);
  if (streamRefs.length < 3) return markdown;

  const manifestRefs = [...block.matchAll(/!\[\[(raw\/assets\/browser-clips\/[^\]]*(?:\.mpd|\.m3u8|manifest)[^\]]*)\]\]/gi)]
    .map((match) => match[1]);
  const replacement = [
    "",
    "## Media",
    "",
    "- Browser video/audio stream package",
    `  - Stream parts detected in original clip: ${streamRefs.length}`,
    manifestRefs[0] ? `  - Manifest/reference file: \`${manifestRefs[0]}\`` : "  - Manifest/reference file: not captured separately",
    "  - Individual stream chunks are preserved under `raw/assets/browser-clips/` but hidden from normal topic and file lists.",
    ""
  ].join("\n");

  return `${markdown.slice(0, mediaMatch.index)}${replacement}${markdown.slice(mediaMatch.index + mediaMatch[0].length)}`;
}

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else result.push(file);
  }
  return result;
}
