#!/usr/bin/env npx tsx
/**
 * add-game.ts
 * Adds any non-Steam game to Steam with artwork from SteamGridDB.
 *
 * Usage:
 *   npx tsx scripts/add-game.ts \
 *     --name "Game Title" \
 *     --exe "D:\Games\game.exe" \
 *     [--start-dir "D:\Games\"] \
 *     [--sgdb-id 12345]          # skip if you want auto-search by name
 *     [--launch-options "..."]
 *     [--tags "tag1,tag2"]
 *     [--dry-run]
 */

import fs from "fs/promises";
import path from "path";
import { promisified as regedit } from "regedit";
import SGDB from "steamgriddb";
import { mkdirp } from "mkdirp";
import { NonSteam } from "../src/classes/index.js";
import { ImageKind } from "../src/types.js";

// ---- arg parsing ----

function arg(flag: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

function flag(f: string): boolean {
  return process.argv.includes(f);
}

const appName    = arg("--name");
const exeRaw     = arg("--exe");
const startDirRaw = arg("--start-dir");
const launchOpts = arg("--launch-options", "");
const tagsRaw    = arg("--tags", "");
const sgdbIdRaw  = arg("--sgdb-id");
const dryRun     = flag("--dry-run");

if (!appName || !exeRaw) {
  console.error("Usage: npx tsx scripts/add-game.ts --name <name> --exe <path> [--start-dir <dir>] [--sgdb-id <id>] [--launch-options <opts>] [--tags <t1,t2>] [--dry-run]");
  process.exit(1);
}

// Wrap exe/start-dir in quotes if not already (Steam's format requires it)
const wrapQuotes = (s: string) => s.startsWith('"') ? s : `"${s}"`;
const exe      = wrapQuotes(exeRaw);
const startDir = wrapQuotes(startDirRaw ?? path.dirname(exeRaw) + path.sep);

// ---- locate Steam dynamically ----

async function findSteamUserDataDir(): Promise<{ steamPath: string; userId: string; userdataDir: string }> {
  let steamPath = "";

  if (process.platform === "win32") {
    const records = await regedit.list(["HKCU\\SOFTWARE\\Valve\\Steam"]);
    steamPath = (records["HKCU\\SOFTWARE\\Valve\\Steam"]?.values?.SteamPath?.value as string) ?? "";
  }

  if (!steamPath) {
    // Fallback: check common paths
    const candidates = [
      "C:/Program Files (x86)/Steam",
      "C:/Program Files/Steam",
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"]!, "Steam") : "",
    ].filter(Boolean);

    for (const c of candidates) {
      try { await fs.access(c); steamPath = c; break; } catch { /* continue */ }
    }
  }

  if (!steamPath) throw new Error("Could not locate Steam installation.");

  // Normalize slashes
  steamPath = steamPath.replace(/\\/g, "/");

  const userdataBase = path.posix.join(steamPath, "userdata");
  let userId = "";

  try {
    const entries = await fs.readdir(userdataBase);
    userId = entries.find(e => /^\d+$/.test(e)) ?? "";
  } catch {
    throw new Error(`Could not read Steam userdata directory at: ${userdataBase}`);
  }

  if (!userId) throw new Error("No Steam user found in userdata directory.");

  return {
    steamPath,
    userId,
    userdataDir: path.posix.join(userdataBase, userId),
  };
}

// ---- SGDB image fetching ----

const sgdb = new SGDB(atob("NjFhNWI0Yjc1NWRjZDEwMDM4ZTQwNDIxOGQ5MDU2YWE="));

const suffixMap: Record<ImageKind, string> = {
  gridVert:  "p",
  gridHoriz: "",
  hero:      "_hero",
  logo:      "_logo",
  icon:      "_icon",
};

async function searchSgdb(name: string): Promise<number | null> {
  const results = await sgdb.searchGame(name);
  if (!results?.length) return null;
  // Pick the closest match by name (case-insensitive exact match first, then first result)
  const exact = results.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
  const pick = exact ?? results[0];
  console.log(`SGDB match: "${pick.name}" (id: ${pick.id})`);
  return pick.id;
}

async function fetchSgdbImages(sgdbId: number): Promise<Partial<Record<ImageKind, string>>> {
  const query = { type: "game" as const, id: sgdbId };
  const [grids, heroes, logos, icons] = await Promise.all([
    sgdb.getGrids(query),
    sgdb.getHeroes(query),
    sgdb.getLogos(query),
    sgdb.getIcons(query),
  ]);

  const vertGrids  = grids.filter((g: any) => g.width < g.height);
  const horizGrids = grids.filter((g: any) => g.width > g.height);

  const urls: Partial<Record<ImageKind, string>> = {};
  if (vertGrids[0])  urls.gridVert  = vertGrids[0].url.toString();
  if (horizGrids[0]) urls.gridHoriz = horizGrids[0].url.toString();
  if (heroes[0])     urls.hero      = heroes[0].url.toString();
  if (logos[0])      urls.logo      = logos[0].url.toString();
  if (icons[0])      urls.icon      = icons[0].url.toString();
  return urls;
}

async function downloadImages(
  appId: number,
  images: Partial<Record<ImageKind, string>>,
  gridDir: string,
): Promise<void> {
  await mkdirp(gridDir);

  for (const [kindStr, url] of Object.entries(images)) {
    const kind = kindStr as ImageKind;
    if (!url) continue;
    const ext = path.extname(new URL(url).pathname);
    const filename = `${appId}${suffixMap[kind]}${ext}`;
    const destPath = path.join(gridDir, filename);
    console.log(`  Downloading ${kind} -> ${filename}`);
    const res = await fetch(url);
    if (!res.ok) { console.warn(`  WARN: HTTP ${res.status} for ${kind}`); continue; }
    const buf = await res.arrayBuffer();
    await fs.writeFile(destPath, new Uint8Array(buf));
    console.log(`    Saved (${(buf.byteLength / 1024).toFixed(1)} KB)`);
  }
}

// ---- main ----

async function main() {
  // 1. Locate Steam
  const { steamPath, userId, userdataDir } = await findSteamUserDataDir();
  const shortcutsPath = path.join(userdataDir, "config", "shortcuts.vdf");
  const gridDir       = path.join(userdataDir, "config", "grid");

  console.log(`Steam path : ${steamPath}`);
  console.log(`User ID    : ${userId}`);
  console.log(`Shortcuts  : ${shortcutsPath}`);

  if (dryRun) {
    console.log("\n[dry-run] Would add:");
    console.log(`  AppName  : ${appName}`);
    console.log(`  Exe      : ${exe}`);
    console.log(`  StartDir : ${startDir}`);
    console.log(`  Tags     : ${tagsRaw}`);
    console.log(`  Launch   : ${launchOpts}`);
    return;
  }

  // 2. Add game entry
  const nonsteam = await NonSteam.load(shortcutsPath);

  // Check for duplicate name
  const existing = nonsteam.shortcuts.entries.find(e => e.appName === appName);
  if (existing) {
    console.warn(`\nWARN: An entry named "${appName}" already exists (id: ${existing.appId}). Skipping add.`);
  } else {
    const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : [];
    nonsteam.addEntry({
      appName:      appName!,
      exe,
      startDir,
      allowOverlay: true,
      launchOptions: launchOpts || undefined,
      tags: tags.length ? tags : undefined,
    });
    console.log(`\nAdded "${appName}" to shortcuts.`);
  }

  // Get the new (or existing) entry's appId for image naming
  const entry = nonsteam.shortcuts.entries.find(e => e.appName === appName);
  if (!entry) throw new Error("Entry not found after add — something went wrong.");
  const appId = entry.appId;
  console.log(`App ID: ${appId}`);

  // 3. Resolve SGDB ID
  let sgdbId: number | null = sgdbIdRaw ? parseInt(sgdbIdRaw, 10) : null;
  if (!sgdbId) {
    console.log(`\nSearching SteamGridDB for "${appName}"...`);
    sgdbId = await searchSgdb(appName!);
    if (!sgdbId) console.warn("WARN: No SGDB match found. Skipping artwork.");
  } else {
    console.log(`\nUsing SGDB ID: ${sgdbId}`);
  }

  // 4. Download images
  if (sgdbId) {
    console.log("Fetching artwork...");
    const images = await fetchSgdbImages(sgdbId);
    console.log(`Found: ${Object.keys(images).join(", ")}`);
    await downloadImages(appId, images, gridDir);

    // Set icon path in entry if icon was downloaded
    if (images.icon) {
      const iconExt = path.extname(new URL(images.icon).pathname);
      entry.icon = path.join(gridDir, `${appId}_icon${iconExt}`);
    }
  }

  // 5. Save
  await nonsteam.shortcuts.save(shortcutsPath);
  console.log(`\nDone! Restart Steam to see "${appName}".`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
