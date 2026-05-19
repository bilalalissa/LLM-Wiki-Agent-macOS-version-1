import fs from "node:fs";
import path from "node:path";
import { listVaults, vaultName } from "./vaults.mjs";

export function deleteArchivedItems(config, items) {
  const results = [];
  for (const item of items) {
    results.push(deleteOneArchivedItem(config, item));
  }
  return results;
}

function deleteOneArchivedItem(config, item) {
  const vaultPath = resolveVault(config, item.vault);
  const rel = normalizeRel(item.file);
  if (!rel) throw new Error("Missing archived file path.");
  if (!isArchiveRel(rel)) throw new Error(`Refusing to delete non-archive path: ${rel}`);

  const fullPath = path.join(vaultPath, rel);
  if (!fs.existsSync(fullPath)) {
    return { vault: vaultName(vaultPath), file: rel, deleted: false, status: "missing" };
  }
  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`Refusing to delete non-file archive path: ${rel}`);
  }

  fs.unlinkSync(fullPath);
  appendMaintenanceLog(vaultPath, rel);
  return { vault: vaultName(vaultPath), file: rel, deleted: true, status: "deleted" };
}

function resolveVault(config, name) {
  const vaultPath = listVaults(config.vaultsRoot).find((item) => vaultName(item) === name);
  if (!vaultPath) throw new Error(`Unknown vault: ${name}`);
  return vaultPath;
}

function normalizeRel(value) {
  if (!value) return "";
  const rel = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.includes("..")) throw new Error(`Unsafe path: ${value}`);
  return rel;
}

function isArchiveRel(rel) {
  return rel.startsWith("raw/processed/archive/") || rel.startsWith("wiki/archive/");
}

function appendMaintenanceLog(vaultPath, rel) {
  const logPath = path.join(vaultPath, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `
## [${date}] maintenance | Permanently delete archived item

Changed:
- Deleted archived file \`${rel}\`.

Notes:
- Deleted from the agent UI Archive tab.
- This action only applies to files already under archive folders.
`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Log\n";
  fs.writeFileSync(logPath, `${existing.trim()}\n${entry}\n`);
}
