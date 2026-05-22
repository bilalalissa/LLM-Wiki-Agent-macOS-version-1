import fs from "node:fs";
import path from "node:path";
import { isIngestibleRawFile, listVaults, readIfExists, vaultName } from "./vaults.mjs";

export function listFileHistory(config) {
  const records = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    records.push(...recordsFromVault(vaultPath));
  }
  return records
    .sort((a, b) => b.processedAtMs - a.processedAtMs)
    .map((record, index) => ({
      number: index + 1,
      ...record,
      receivedAt: formatLocal(record.receivedAtMs),
      processedAt: formatLocal(record.processedAtMs)
    }));
}

export function listArchiveHistory(config) {
  const records = [];
  for (const vaultPath of listVaults(config.vaultsRoot)) {
    records.push(...archiveRecordsFromVault(vaultPath));
  }
  return records
    .sort((a, b) => b.archivedAtMs - a.archivedAtMs)
    .map((record, index) => ({
      number: index + 1,
      ...record,
      archivedAt: formatLocal(record.archivedAtMs)
    }));
}

function recordsFromVault(vaultPath) {
  const sourcePages = mapSourcePages(vaultPath);
  const files = [];
  for (const dir of [path.join(vaultPath, "raw", "processed"), path.join(vaultPath, "raw", "assets")]) {
    if (fs.existsSync(dir)) walk(dir, files);
  }
  return files
    .filter((file) => isIngestibleRawFile(file))
    .filter((file) => !path.relative(vaultPath, file).replace(/\\/g, "/").includes("/archive/"))
    .map((file) => {
      const rel = path.relative(vaultPath, file);
      const stats = fs.statSync(file);
      const sourcePage = sourcePages.get(rel);
      const sourceStats = sourcePage ? fs.statSync(path.join(vaultPath, sourcePage)) : null;
      return {
        vault: vaultName(vaultPath),
        file: rel,
        sourcePage,
        status: sourcePage ? "processed" : "processed file only",
        receivedAtMs: stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs,
        processedAtMs: sourceStats?.mtimeMs || stats.mtimeMs
      };
    });
}

function mapSourcePages(vaultPath) {
  const sourceDir = path.join(vaultPath, "wiki", "sources");
  const map = new Map();
  const files = [];
  if (fs.existsSync(sourceDir)) walk(sourceDir, files);
  for (const file of files.filter((item) => item.endsWith(".md"))) {
    const text = readIfExists(file);
    const match = text.match(/^source_path:\s*(.+)$/m);
    if (!match) continue;
    const sourcePath = match[1].trim().replace(/^["']|["']$/g, "");
    map.set(sourcePath, path.relative(vaultPath, file));
  }
  return map;
}

function archiveRecordsFromVault(vaultPath) {
  const roots = [
    { dir: path.join(vaultPath, "raw", "processed", "archive"), kind: "raw source" },
    { dir: path.join(vaultPath, "raw", "assets", "archive"), kind: "media source" },
    { dir: path.join(vaultPath, "wiki", "archive"), kind: "wiki page" }
  ];
  const records = [];
  for (const root of roots) {
    const files = [];
    if (fs.existsSync(root.dir)) walk(root.dir, files);
    for (const file of files.filter((item) => isIngestibleRawFile(item))) {
      const stats = fs.statSync(file);
      records.push({
        vault: vaultName(vaultPath),
        kind: root.kind,
        file: path.relative(vaultPath, file),
        relation: archiveRelation(vaultPath, file, root.kind),
        archivedAtMs: stats.ctimeMs || stats.mtimeMs
      });
    }
  }
  return records;
}

function archiveRelation(vaultPath, file, kind) {
  const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
  if (kind === "raw source") return sourceSetLabel(rel);
  if (rel.startsWith("wiki/archive/sources/")) return sourceSetLabel(rel);

  const text = readIfExists(file);
  const sourceLink = text.match(/\[\[wiki\/sources\/([^|\]]+)/);
  if (sourceLink) return sourceSetLabel(sourceLink[1]);
  const sourcePath = text.match(/^source_path:\s*(.+)$/m);
  if (sourcePath) return sourceSetLabel(sourcePath[1].trim().replace(/^["']|["']$/g, ""));
  return "Archive-only item";
}

function sourceSetLabel(value) {
  const base = path.basename(value, path.extname(value));
  return base ? `Source set: ${base}` : "Archive-only item";
}

function walk(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file, result);
    } else {
      result.push(file);
    }
  }
}

function formatLocal(ms) {
  const date = new Date(ms);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + (zone ? ` ${zone}` : "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}
