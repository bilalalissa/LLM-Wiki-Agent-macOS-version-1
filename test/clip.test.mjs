import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveBrowserClip } from "../src/clip.mjs";

function makeConfig(root) {
  return {
    vaultsRoot: root,
    watchIntervalMs: 5000,
    ingestMaxChars: 60000,
    chatMaxFiles: 24
  };
}

function makeVaultRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-clip-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  return { root, vault };
}

test("browser clips are saved as raw input markdown", async () => {
  const { root, vault } = makeVaultRoot();

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "selection",
    title: "Interesting page",
    url: "https://example.test/article",
    text: "Selected insight for the wiki.",
    tags: ["#Research", "meeting notes", "ai/agents", "Research", "bad tag!"]
  });

  assert.equal(result.vault, "Research-vault");
  assert.match(result.file, /^raw\/input\/.*browser--selection--interesting-page\.md$/);
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /type: browser-clip/);
  assert.match(markdown, /tags:\n  - "browser-clip"\n  - "Research"\n  - "meeting-notes"\n  - "ai\/agents"\n  - "bad-tag"/);
  assert.match(markdown, /- Tags: #Research, #meeting-notes, #ai\/agents, #bad-tag/);
  assert.match(markdown, /Selected insight for the wiki\./);
});

test("browser clip media data URLs are saved as vault assets", async () => {
  const { root, vault } = makeVaultRoot();
  const pngDataUrl = `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`;

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Diagram",
    url: "https://example.test/diagram",
    text: "Diagram clip.",
    media: [{ url: "https://example.test/diagram.png", alt: "Diagram", dataUrl: pngDataUrl }]
  });

  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0], /^raw\/assets\/browser-clips\/.*diagram\.png$/);
  assert.equal(fs.readFileSync(path.join(vault, result.assets[0]), "utf8"), "fake-png");
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /!\[\[raw\/assets\/browser-clips\//);
});

test("browser clip media URLs are downloaded as vault assets when possible", async () => {
  const { root, vault } = makeVaultRoot();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": Buffer.byteLength("downloaded-png")
    });
    response.end("downloaded-png");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const result = await saveBrowserClip(makeConfig(root), {
      vault: "Research-vault",
      captureType: "media",
      title: "Downloaded Diagram",
      url: `http://127.0.0.1:${port}/page`,
      text: "Diagram clip.",
      media: [{ url: `http://127.0.0.1:${port}/diagram.png`, alt: "Downloaded Diagram" }]
    });

    assert.equal(result.assets.length, 1);
    assert.match(result.assets[0], /^raw\/assets\/browser-clips\/.*downloaded-diagram\.png$/);
    assert.equal(fs.readFileSync(path.join(vault, result.assets[0]), "utf8"), "downloaded-png");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("browser stream chunks are summarized without saving chunk assets", async () => {
  const { root, vault } = makeVaultRoot();
  const dataUrl = `data:video/mp4;base64,${Buffer.from("chunk").toString("base64")}`;

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Video stream",
    url: "https://example.test/video",
    text: "Video clip.",
    media: [
      { url: "https://stream.example/video/1080/init.mp4", filename: "init.mp4", dataUrl },
      { url: "https://stream.example/video/1080/seg_1.mp4", filename: "seg_1.mp4", dataUrl },
      { url: "https://stream.example/video/1080/seg_2.mp4", filename: "seg_2.mp4", dataUrl },
      { url: "https://stream.example/video/1080/seg_3.mp4", filename: "seg_3.mp4", dataUrl }
    ]
  });

  assert.equal(result.assets.length, 0);
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /Browser video\/audio stream reference/);
  assert.match(markdown, /Stream chunks were not saved to vault assets/);
  assert.doesNotMatch(markdown, /!\[\[raw\/assets\/browser-clips\/.*seg_1/);
});

test("browser stream summary handles more than 400 manifest chunks without assets", async () => {
  const { root, vault } = makeVaultRoot();
  const dataUrl = `data:video/mp2t;base64,${Buffer.from("chunk").toString("base64")}`;
  const media = Array.from({ length: 425 }, (_item, index) => ({
    url: `https://stream.example/hls/segment-${index + 1}.ts`,
    filename: `segment-${index + 1}.ts`,
    dataUrl
  }));

  const result = await saveBrowserClip(makeConfig(root), {
    vault: "Research-vault",
    captureType: "media",
    title: "Long HLS stream",
    url: "https://example.test/video",
    text: "Long video clip.",
    media
  });

  assert.equal(result.assets.length, 0);
  const markdown = fs.readFileSync(path.join(vault, result.file), "utf8");
  assert.match(markdown, /Stream references received: 425/);
  assert.doesNotMatch(markdown, /stream-manifest\.json/);
});
