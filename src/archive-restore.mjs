import fs from "node:fs";
import path from "node:path";
import { listVaults, vaultName } from "./vaults.mjs";

export function restoreArchivedItems(config, items) {
  const results = [];
  for (const item of items) {
    results.push(restoreOneArchivedItem(config, item));
  }
  return results;
}

function restoreOneArchivedItem(config, item) {
  const vaultPath = resolveVault(config, item.vault);
  const archiveRel = normalizeRel(item.file);
  if (!archiveRel) throw new Error("Missing archived file path.");
  if (!isArchiveRel(archiveRel)) throw new Error(`Refusing to restore non-archive path: ${archiveRel}`);

  const from = path.join(vaultPath, archiveRel);
  if (!fs.existsSync(from)) {
    return { vault: vaultName(vaultPath), from: archiveRel, restored: false, status: "missing" };
  }
  if (!fs.statSync(from).isFile()) {
    throw new Error(`Refusing to restore non-file archive path: ${archiveRel}`);
  }

  const activeRel = activeRelForArchive(archiveRel);
  const to = uniquePath(path.join(vaultPath, activeRel));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);

  const restoredTo = path.relative(vaultPath, to);
  appendMaintenanceLog(vaultPath, archiveRel, restoredTo);
  return { vault: vaultName(vaultPath), from: archiveRel, to: restoredTo, restored: true, status: "restored" };
}

function activeRelForArchive(rel) {
  if (rel.startsWith("raw/processed/archive/")) {
    return rel.replace(/^raw\/processed\/archive\//, "raw/processed/");
  }
  if (rel.startsWith("wiki/archive/")) {
    return rel.replace(/^wiki\/archive\//, "wiki/");
  }
  throw new Error(`Unsupported archive path: ${rel}`);
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

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const parsed = path.parse(file);
  let index = 2;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}-restored-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function appendMaintenanceLog(vaultPath, fromRel, toRel) {
  const logPath = path.join(vaultPath, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `
## [${date}] maintenance | Restore archived item

Changed:
- Restored \`${fromRel}\` to \`${toRel}\`.

Notes:
- Restored from the agent UI Archive tab.
- Active index rows and cross-references removed during archive are not automatically reconstructed.
`;
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Log\n";
  fs.writeFileSync(logPath, `${existing.trim()}\n${entry}\n`);
}
