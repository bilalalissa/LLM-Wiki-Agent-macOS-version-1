import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureSharedSettings,
  listBridgeVaults,
  sharedSettingsForVault,
  sharedSettingsPath,
  updateSharedSettingsForVault
} from "../src/shared-settings.mjs";
import { listRawCandidates } from "../src/vaults.mjs";

function makeConfig(root) {
  return {
    provider: "openai_subscription",
    model: "gpt-5.4",
    vaultsRoot: root,
    watchIntervalMs: 5000,
    ingestMaxChars: 60000,
    chatMaxFiles: 24
  };
}

function makeVaultRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-shared-settings-"));
  process.env.OBSIDIAN_VAULTS_FILE = path.join(root, "empty-obsidian-registry.json");
  const vault = path.join(root, "Research-vault");
  fs.mkdirSync(vault, { recursive: true });
  return { root, vault };
}

test("ensureSharedSettings creates a redacted cross-agent manifest", () => {
  const { root, vault } = makeVaultRoot();
  const settings = ensureSharedSettings(vault, makeConfig(root));

  assert.equal(settings.schemaVersion, 1);
  assert.equal(settings.provider.mode, "openai_subscription");
  assert.equal(settings.provider.transport, "mac_bridge");
  assert.equal(settings.provider.credentialStatus, "local_only");
  assert.ok(fs.existsSync(sharedSettingsPath(vault)));
});

test("ensureSharedSettings removes secret-shaped provider fields", () => {
  const { root, vault } = makeVaultRoot();
  const config = makeConfig(root);
  fs.mkdirSync(path.dirname(sharedSettingsPath(vault)), { recursive: true });
  fs.writeFileSync(sharedSettingsPath(vault), JSON.stringify({
    provider: {
      mode: "openai_subscription",
      transport: "mac_bridge",
      defaultModel: "gpt-5.4",
      apiKey: "sk-test",
      bridgeToken: "secret",
      credentialStatus: "configured"
    }
  }));

  const settings = ensureSharedSettings(vault, config);

  assert.equal(settings.provider.credentialStatus, "local_only");
  assert.equal(settings.provider.apiKey, undefined);
  assert.equal(settings.provider.bridgeToken, undefined);
});

test("bridge vault helpers expose and update non-secret settings", () => {
  const { root } = makeVaultRoot();
  const config = makeConfig(root);

  const vaults = listBridgeVaults(config);
  assert.equal(vaults.length, 1);
  assert.equal(vaults[0].name, "Research-vault");

  const updated = updateSharedSettingsForVault(config, "Research-vault", {
    display: { theme: "forest" },
    provider: { bridgeURL: "http://mac.local:8789", bridgeToken: "must-not-save" }
  });

  assert.equal(updated.settings.display.theme, "forest");
  assert.equal(updated.settings.provider.bridgeURL, "http://mac.local:8789");
  assert.equal(updated.settings.provider.bridgeToken, undefined);

  const read = sharedSettingsForVault(config, "Research-vault");
  assert.equal(read.settings.display.theme, "forest");
});

test("shared settings default reflects high-level plan progress fields without secrets", () => {
  const { root, vault } = makeVaultRoot();
  const settings = ensureSharedSettings(vault, makeConfig(root));

  assert.equal(settings.provider.credentialStatus, "local_only");
  assert.equal(settings.provider.mode, "openai_subscription");
  assert.equal(settings.provider.transport, "mac_bridge");
  assert.ok(Array.isArray(settings.lastKnownAgents));
});

test("raw candidate scan skips processed and asset folders before descent", () => {
  const { vault } = makeVaultRoot();
  fs.mkdirSync(path.join(vault, "raw", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(vault, "raw", "assets", "browser-clips", "package"), { recursive: true });
  fs.mkdirSync(path.join(vault, "raw", "processed"), { recursive: true });
  fs.writeFileSync(path.join(vault, "raw", "inbox", "note.md"), "# Note\n");
  fs.writeFileSync(path.join(vault, "raw", "assets", "browser-clips", "package", "chunk.m4s"), "media");
  fs.writeFileSync(path.join(vault, "raw", "processed", "old.md"), "# Old\n");

  const rel = listRawCandidates(vault).map((file) => path.relative(vault, file));

  assert.deepEqual(rel, [path.join("raw", "inbox", "note.md")]);
});
