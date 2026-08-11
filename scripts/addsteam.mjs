#!/usr/bin/env node
/**
 * addsteam - add a non-Steam PC game to Steam from a single path, with artwork.
 *
 *   addsteam "C:\Games\GameHere\Launch.exe"
 *   addsteam "C:\Games\GameHere"
 *
 * Wraps the nonsteam library (shortcuts.vdf reader/writer) and SteamGridDB, and adds
 * the pieces the bare CLI leaves to the caller:
 *
 *   - finds the logged-in Steam account instead of guessing the first userdata folder
 *   - derives the game name from the path and looks the game up on SteamGridDB by name
 *     (the nonsteam CLI only accepts a numeric --sgdb-id)
 *   - writes all five artwork files into userdata/<id>/config/grid itself, because
 *     nonsteam's own image copy silently no-ops when Steam's registry user key is absent,
 *     which it is on this machine
 *   - closes Steam before touching shortcuts.vdf and restarts it after; a running Steam
 *     holds the file in memory and flushes its own copy back out on exit, which would
 *     otherwise throw the new entry away
 *   - backs up shortcuts.vdf before every write
 *
 * Run 'addsteam --help' for options.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------- logging ---

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS = { INFO: "\x1b[36m", SUCCESS: "\x1b[32m", WARN: "\x1b[33m", ERROR: "\x1b[31m", DEBUG: "\x1b[90m" };

function log(message, level = "INFO") {
  if (level === "DEBUG" && !process.env.ADDSTEAM_DEBUG) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const line = `[${ts}] [${level}] ${message}`;
  const stream = level === "ERROR" ? process.stderr : process.stdout;
  stream.write(COLOR ? `${COLORS[level] || ""}${line}\x1b[0m\n` : `${line}\n`);
}

class UserError extends Error {}

// ------------------------------------------------------------ arg parsing ---

const USAGE = `
addsteam - add a non-Steam game to Steam, with artwork, from one path.

Usage:
  addsteam <exe-or-folder> [options]
  addsteam --list
  addsteam --help

Arguments:
  <exe-or-folder>            The game executable. A folder is searched for the
                             most likely game exe.

Options:
  -n, --name <name>          Game name. Default: derived from the path, then
                             replaced by the SteamGridDB title on a strong match.
      --keep-name            Never replace the derived name with the SGDB title.
      --sgdb-id <id>         Use this SteamGridDB game id, skipping the search.
      --pick                 Choose the SGDB match (and the exe, if ambiguous)
                             interactively instead of taking the best guess.
      --no-art               Add the entry without downloading artwork.
      --animated             Allow animated artwork (default: static only).
  -d, --start-dir <dir>      Working directory. Default: the exe's folder.
  -o, --launch-options <s>   Steam launch options, e.g. 'ARG=1 %command%'.
  -t, --tags <a,b,c>         Steam collections/tags to assign.
      --no-overlay           Disable the Steam overlay for this entry.
  -u, --user <steamid32>     Target userdata folder. Default: the logged-in account.
  -i, --input <shortcuts>    Use a specific shortcuts.vdf.
      --restart-steam <mode> auto (default) | never | always. 'auto' closes Steam
                             before writing and reopens it after, but only if it
                             was running.
      --force                Add a second entry even if this game is already there.
      --dry-run              Show what would happen, change nothing.
      --list                 List the non-Steam entries already in Steam.
  -h, --help                 Show this help.

Environment:
  ADDSTEAM_STEAM_USER        Default --user.
  SGDB_API_KEY               Use your own SteamGridDB key instead of the built-in one.
  ADDSTEAM_DEBUG=1           Verbose output.
`.trim();

const FLAGS_WITH_VALUES = new Set([
  "--name", "-n", "--sgdb-id", "--start-dir", "-d", "--launch-options", "-o",
  "--tags", "-t", "--user", "-u", "--input", "-i", "--restart-steam",
]);

function parseArgs(argv) {
  const opts = {
    target: null, name: null, keepName: false, sgdbId: null, pick: false,
    art: true, animated: false, startDir: null, launchOptions: "", tags: [],
    overlay: true, user: process.env.ADDSTEAM_STEAM_USER || null, input: null,
    restartSteam: "auto", force: false, dryRun: false, list: false, help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needsValue = FLAGS_WITH_VALUES.has(a);
    const value = needsValue ? argv[++i] : undefined;
    if (needsValue && value === undefined) throw new UserError(`Option ${a} needs a value.`);

    switch (a) {
      case "-n": case "--name": opts.name = value; break;
      case "--keep-name": opts.keepName = true; break;
      case "--sgdb-id": opts.sgdbId = Number.parseInt(value, 10); break;
      case "--pick": opts.pick = true; break;
      case "--no-art": case "--no-artwork": opts.art = false; break;
      case "--animated": opts.animated = true; break;
      case "-d": case "--start-dir": opts.startDir = value; break;
      case "-o": case "--launch-options": opts.launchOptions = value; break;
      case "-t": case "--tags": opts.tags = value.split(",").map(s => s.trim()).filter(Boolean); break;
      case "--no-overlay": opts.overlay = false; break;
      case "-u": case "--user": opts.user = value; break;
      case "-i": case "--input": opts.input = value; break;
      case "--restart-steam": opts.restartSteam = String(value).toLowerCase(); break;
      case "--no-restart": opts.restartSteam = "never"; break;
      case "--force": opts.force = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--list": opts.list = true; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) throw new UserError(`Unknown option: ${a}`);
        if (opts.target) throw new UserError(`Unexpected extra argument: ${a}`);
        opts.target = a;
    }
  }

  if (opts.sgdbId !== null && Number.isNaN(opts.sgdbId)) throw new UserError("--sgdb-id must be a number.");
  if (!["auto", "never", "always"].includes(opts.restartSteam)) {
    throw new UserError("--restart-steam must be auto, never or always.");
  }
  return opts;
}

// ------------------------------------------------------- steam discovery ---

async function regQuery(key, value) {
  if (!IS_WINDOWS) return null;
  try {
    const { stdout } = await execFileAsync("reg", ["query", key, "/v", value], { windowsHide: true });
    const match = stdout.match(/^\s*\S+\s+REG_\w+\s+(.*?)\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function findSteamPath() {
  if (process.env.ADDSTEAM_STEAM_PATH) return process.env.ADDSTEAM_STEAM_PATH;

  const fromRegistry = await regQuery("HKCU\\SOFTWARE\\Valve\\Steam", "SteamPath");
  const candidates = [
    fromRegistry,
    ...(IS_WINDOWS
      ? [
          process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Steam"),
          process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Steam"),
        ]
      : [
          path.join(os.homedir(), ".steam", "steam"),
          path.join(os.homedir(), ".local", "share", "Steam"),
          path.join(os.homedir(), ".var", "app", "com.valvesoftware.Steam", ".steam", "steam"),
        ]),
  ].filter(Boolean).map(p => path.normalize(p));

  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, "userdata"))) return candidate;
  }
  throw new UserError(
    "Could not find a Steam installation. Set ADDSTEAM_STEAM_PATH to your Steam folder."
  );
}

/**
 * Steam's registry key that nonsteam reads (HKCU\...\Valve\Steam\Users) does not exist on
 * every install, so the account is resolved from ActiveProcess\ActiveUser first - that is
 * the account actually signed in - and only then from the userdata folders themselves.
 * Picking the wrong folder writes a shortcut that never shows up.
 */
async function findSteamUser(steamPath, requested) {
  const userdataBase = path.join(steamPath, "userdata");
  let dirs;
  try {
    dirs = (await fs.readdir(userdataBase, { withFileTypes: true }))
      .filter(d => d.isDirectory() && /^\d+$/.test(d.name) && d.name !== "0")
      .map(d => d.name);
  } catch {
    throw new UserError(`Could not read ${userdataBase}.`);
  }
  if (!dirs.length) throw new UserError(`No Steam accounts found in ${userdataBase}.`);

  if (requested) {
    if (!dirs.includes(String(requested))) {
      throw new UserError(`No userdata folder for account ${requested}. Found: ${dirs.join(", ")}`);
    }
    return String(requested);
  }

  const activeUserRaw = await regQuery("HKCU\\SOFTWARE\\Valve\\Steam\\ActiveProcess", "ActiveUser");
  const activeUser = activeUserRaw ? Number.parseInt(activeUserRaw, 16) : 0;
  if (activeUser && dirs.includes(String(activeUser))) {
    log(`Steam account: ${activeUser} (signed in)`, "DEBUG");
    return String(activeUser);
  }

  if (dirs.length === 1) return dirs[0];

  // Fall back to whichever account Steam touched most recently.
  const ranked = dirs.map(id => {
    const probes = [
      path.join(userdataBase, id, "config", "localconfig.vdf"),
      path.join(userdataBase, id, "config", "shortcuts.vdf"),
      path.join(userdataBase, id),
    ];
    const mtime = Math.max(...probes.map(p => {
      try { return fsSync.statSync(p).mtimeMs; } catch { return 0; }
    }));
    return { id, mtime };
  }).sort((a, b) => b.mtime - a.mtime);

  log(`Multiple Steam accounts (${dirs.join(", ")}); using the most recently used: ${ranked[0].id}.`, "WARN");
  log("Pass --user <id> to target a different one.", "WARN");
  return ranked[0].id;
}

function steamExePath(steamPath) {
  const exe = path.join(steamPath, IS_WINDOWS ? "steam.exe" : "steam");
  return fsSync.existsSync(exe) && fsSync.statSync(exe).isFile() ? exe : null;
}

// --------------------------------------------------- steam start / stop ---

async function isSteamRunning() {
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"], { windowsHide: true });
      return /steam\.exe/i.test(stdout);
    }
    const { stdout } = await execFileAsync("pgrep", ["-x", "steam"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function isElevated() {
  if (!IS_WINDOWS) return false;
  try {
    const { stdout } = await execFileAsync("whoami", ["/groups"], { windowsHide: true });
    return stdout.includes("S-1-16-12288") || stdout.includes("S-1-16-16384");
  } catch {
    return false;
  }
}

async function shutdownSteam(steamExe) {
  if (!steamExe) {
    log("Steam is running but steam.exe was not found; close Steam yourself before continuing.", "WARN");
    return false;
  }
  log("Closing Steam so it cannot overwrite shortcuts.vdf on exit...");
  spawn(steamExe, ["-shutdown"], { detached: true, stdio: "ignore", windowsHide: true }).unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (!(await isSteamRunning())) return true;
  }
  log("Steam did not exit within 30s. Close it and run addsteam again, or the entry may be lost.", "WARN");
  return false;
}

/**
 * Start-Process-style launches hand the child a copy of our token, so relaunching from an
 * elevated shell leaves an elevated Steam behind - and every emulator it launches then
 * inherits admin until the next reboot. explorer.exe already runs at medium integrity, so
 * letting it be the parent keeps Steam unelevated.
 */
async function startSteam(steamExe) {
  if (!steamExe) {
    log("Could not find steam.exe to restart; start Steam yourself to see the game.", "WARN");
    return;
  }
  log("Restarting Steam...");
  if (IS_WINDOWS && await isElevated()) {
    log("Shell is elevated - starting Steam via explorer.exe so it does not inherit administrator.");
    try {
      spawn(path.join(process.env.WINDIR || "C:\\Windows", "explorer.exe"), [steamExe],
        { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return;
    } catch (err) {
      log(`explorer.exe handoff failed (${err.message}); starting Steam directly - it will be elevated.`, "WARN");
    }
  }
  spawn(steamExe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// ------------------------------------------------------- exe resolution ---

const EXE_BLOCKLIST = /(^|[^a-z])(unins|uninstall|setup|install|redist|vcredist|vc_redist|dxsetup|dxwebsetup|directx|dotnet|oalinst|crashhandler|crashreport|crashsender|unitycrashhandler|bugreport|notification_helper|touchup|dwebview|cefsub|subprocess|helper|server|dedicated|editor|benchmark|config|settings|patcher|updater|activation|python|ffmpeg|7z|winrar)/i;

// Folders that sit between the install root and the exe and never name the game.
const CONTAINER_DIRS = new Set([
  "bin", "bin64", "binaries", "win64", "win32", "x64", "x86", "release", "debug",
  "game", "app", "application", "data", "dist", "build", "builds", "win", "windows",
  "launcher", "client", "runtime", "shipping",
]);

// Folders above the install root: library and system paths, never a game name either.
const LIBRARY_DIRS = new Set([
  "games", "pc", "program files", "program files (x86)", "programdata", "users",
  "documents", "downloads", "desktop", "appdata", "local", "locallow", "roaming",
  "steamlibrary", "steamapps", "common", "emulation", "roms", "library", "apps",
  "software", "install", "installed", "portable", "my games", "github", "git",
  "epic games", "gog games", "gog galaxy", "ubisoft", "xboxgames", "origin games",
  "ea games", "battle.net", "amazon games", "itch", "repacks", "onedrive",
  os.userInfo().username.toLowerCase(),
]);

const GENERIC_STEMS = new Set([
  "launch", "launcher", "start", "startgame", "start_game", "run", "rungame", "play",
  "game", "app", "main", "client", "bin", "boot", "loader", "steam", "index", "exe",
]);

async function walkExecutables(root, maxDepth = 4) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || found.length > 4000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(\.|node_modules$|_CommonRedist$|DirectX$|redist)/i.test(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".exe") {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}

function scoreExe(exePath, root) {
  const stem = path.basename(exePath, path.extname(exePath));
  const rootName = path.basename(root);
  const depth = path.relative(root, exePath).split(path.sep).length - 1;
  let score = 0;

  if (EXE_BLOCKLIST.test(stem)) score -= 100;
  if (normalize(stem) === normalize(rootName)) score += 40;
  else if (normalize(rootName).includes(normalize(stem)) && stem.length > 3) score += 20;
  if (/-Win64-Shipping$/i.test(stem)) score += 30;      // Unreal Engine
  if (/-Win32-Shipping$/i.test(stem)) score += 15;
  if (GENERIC_STEMS.has(stem.toLowerCase())) score += 10;   // Launch.exe is still a launcher
  if (/(x64|win64|64)$/i.test(stem)) score += 5;
  if (/(x86|win32|32)$/i.test(stem)) score -= 2;
  score -= depth * 3;

  try { score += Math.min(20, fsSync.statSync(exePath).size / (1024 * 1024 * 5)); } catch { /* ignore */ }
  return score;
}

async function resolveExe(target, pick) {
  const resolved = path.resolve(target.replace(/[/\\]+$/, ""));
  let stat;
  try { stat = await fs.stat(resolved); } catch {
    throw new UserError(`Path not found: ${resolved}`);
  }

  if (stat.isFile()) return resolved;

  const candidates = (await walkExecutables(resolved))
    .map(exe => ({ exe, score: scoreExe(exe, resolved) }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) throw new UserError(`No .exe found under ${resolved}.`);

  const viable = candidates.filter(c => c.score > -50);
  if (!viable.length) throw new UserError(`Only installers/uninstallers found under ${resolved}. Pass the exe directly.`);

  if (pick && viable.length > 1) {
    const choice = await promptChoice(
      "Which executable should Steam launch?",
      viable.slice(0, 10).map(c => path.relative(resolved, c.exe))
    );
    return viable[choice].exe;
  }

  if (viable.length > 1) {
    log(`Picked ${path.basename(viable[0].exe)} out of ${viable.length} executables. Use --pick to choose.`, "DEBUG");
  }
  return viable[0].exe;
}

// ---------------------------------------------------------- name guessing ---

// Release-group and packaging tags only. Words that belong to real titles - "Complete",
// "Final", "Remastered" - are deliberately absent: stripping them turns "DiRT 3 Complete
// Edition" into "DiRT 3 Edition" and "Final Fantasy" into "Fantasy".
const NOISE_TOKENS = /\b(repack|multi\d+|steamrip|steam-rip|drm-?free|fitgirl|dodi|elamigos|codex|plaza|skidrow|cpy|rune|empress|tenoke|razor1911|goldberg|crack(ed|fix)?|setup|installer|x64|x86|win64|win32|shipping)\b/gi;

/**
 * SteamGridDB's search is close to literal: "FiveNightsatFreddys" returns nothing at all,
 * while "Five Nightsat Freddys" returns the real game as the first hit. Splitting on case
 * and digit boundaries is only ever done to the query - the split is too crude to show a
 * user ("DiRT" becomes "Di RT"), but similarity is compared on letters alone, so a scruffy
 * query still scores an exact match against the proper title.
 */
function splitWords(raw) {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanTitle(raw) {
  return raw
    .replace(/\.(exe|lnk|url|bat|cmd)$/i, "")
    .replace(/[[({][^\])}]*[\])}]/g, " ")        // (2026), [FitGirl Repack], {v1.2}
    .replace(/[._]+/g, " ")
    .replace(/\bv?\d+(\.\d+){1,3}\b/g, " ")      // v1.2.3 / 1.02
    .replace(NOISE_TOKENS, " ")
    .replace(/\s*-\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * "C:\Games\GameHere\Launch.exe" should become "GameHere", not "Launch".
 *
 * Drop the library folders above the game (H:\Games\PC\...) and the container folders
 * below it (\Binaries\Win64\), and what is left is the install root - the folder someone
 * named after the game. Its innermost sibling and the exe stem come along as backups,
 * because engines like Unreal put a project codename in between: Hi-Fi RUSH installs to
 * "Hi-Fi RUSH\Hibiki\Binaries\Win64\Hi-Fi-RUSH.exe". The SGDB lookup then picks whichever
 * candidate actually matches a real game.
 */
function nameCandidates(exePath) {
  const stem = path.basename(exePath, path.extname(exePath));
  const parts = path.dirname(exePath).split(path.sep).filter(Boolean)
    .filter(p => !/^[a-z]:$/i.test(p));

  const meaningful = parts.filter(p => {
    const key = p.toLowerCase();
    return !LIBRARY_DIRS.has(key) && !CONTAINER_DIRS.has(key);
  });

  const candidates = [
    meaningful[0],                          // install root
    meaningful[meaningful.length - 1],      // innermost real folder (project codename)
    stem.replace(/-Win(64|32)-Shipping$/i, ""),
  ].filter(Boolean).map(cleanTitle);

  const seen = new Set();
  const unique = candidates.filter(c => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
  return unique.length ? unique : [stem];
}

// ------------------------------------------------------------ SteamGridDB ---

// nonsteam ships this key in its own source ("intentionally committed"), so it is the
// upstream project's public key rather than anything of ours. SGDB_API_KEY overrides it.
const DEFAULT_SGDB_KEY = atob("NjFhNWI0Yjc1NWRjZDEwMDM4ZTQwNDIxOGQ5MDU2YWE=");

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const bigrams = str => {
    const set = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const g = str.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let hits = 0;
  for (const [g, count] of bx) hits += Math.min(count, by.get(g) || 0);
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 ? (2 * hits) / total : 0;
}

async function searchSgdb(sgdb, candidates, pick) {
  let best = null;
  for (const candidate of candidates) {
    const query = splitWords(candidate);
    let results;
    try {
      results = await sgdb.searchGame(query);
    } catch (err) {
      log(`SteamGridDB search failed for "${query}": ${err.message}`, "WARN");
      continue;
    }
    if (!results?.length) continue;

    const ranked = results
      .map(game => ({ game, score: similarity(game.name, candidate) }))
      .sort((a, b) => b.score - a.score);

    if (pick) {
      const choice = await promptChoice(
        `SteamGridDB matches for "${candidate}":`,
        ranked.slice(0, 8).map(r => `${r.game.name}  (id ${r.game.id})`),
        true
      );
      if (choice === null) continue;
      return { ...ranked[choice].game, matchScore: 1, query: candidate };
    }

    if (!best || ranked[0].score > best.matchScore) {
      // SGDB titles occasionally carry stray whitespace ("Mystery Case Files: Madame Fate ").
      best = { ...ranked[0].game, name: ranked[0].game.name.trim(), matchScore: ranked[0].score, query: candidate };
    }
    if (best.matchScore >= 0.95) break;   // exact enough, stop asking
  }
  return best;
}

const GRID_VERT_DIMS = ["600x900", "660x930", "342x482"];
const GRID_HORIZ_DIMS = ["920x430", "460x215", "1920x620"];

function rankImages(images, preferredDims, allowAnimated) {
  return images
    .filter(img => allowAnimated || !/\.(webm|gif|apng)$/i.test(new URL(img.url).pathname))
    .map(img => {
      let score = 0;
      const dims = `${img.width}x${img.height}`;
      const dimIndex = preferredDims.indexOf(dims);
      if (dimIndex === 0) score += 20;
      else if (dimIndex > 0) score += 10;
      if (img.style?.includes("official")) score += 6;
      if (img.style?.includes("alternate")) score += 3;
      score += Math.min(10, (img.upvotes || 0) / 5);
      score -= Math.min(10, (img.downvotes || 0));
      score += Math.min(5, (img.score || 0) / 100);
      return { img, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(r => r.img);
}

async function fetchArtwork(sgdb, sgdbId, allowAnimated) {
  const query = { type: "game", id: sgdbId, nsfw: "false", humor: "false" };
  const safe = async fn => { try { return await fn(); } catch (err) { log(`SGDB: ${err.message}`, "DEBUG"); return []; } };

  const [grids, heroes, logos, icons] = await Promise.all([
    safe(() => sgdb.getGrids(query)),
    safe(() => sgdb.getHeroes(query)),
    safe(() => sgdb.getLogos(query)),
    safe(() => sgdb.getIcons(query)),
  ]);

  const vertical = rankImages(grids.filter(g => g.height > g.width), GRID_VERT_DIMS, allowAnimated);
  const horizontal = rankImages(grids.filter(g => g.width > g.height), GRID_HORIZ_DIMS, allowAnimated);

  const art = {};
  if (vertical[0]) art.gridVert = vertical[0].url.toString();
  if (horizontal[0]) art.gridHoriz = horizontal[0].url.toString();
  const hero = rankImages(heroes, ["1920x620", "3840x1240", "1600x650"], allowAnimated);
  if (hero[0]) art.hero = hero[0].url.toString();
  const logo = rankImages(logos, [], allowAnimated);
  if (logo[0]) art.logo = logo[0].url.toString();
  const icon = rankImages(icons, ["256x256", "512x512"], allowAnimated);
  if (icon[0]) art.icon = icon[0].url.toString();
  return art;
}

// Steam's naming for userdata/<id>/config/grid.
const ART_SUFFIX = { gridVert: "p", gridHoriz: "", hero: "_hero", logo: "_logo", icon: "_icon" };

async function downloadArtwork(art, appId, gridDir) {
  await fs.mkdir(gridDir, { recursive: true });
  const written = {};

  for (const [kind, url] of Object.entries(art)) {
    const base = `${appId}${ART_SUFFIX[kind]}`;
    const ext = path.extname(new URL(url).pathname) || ".png";
    const dest = path.join(gridDir, `${base}${ext}`);
    try {
      const res = await fetch(url);
      if (!res.ok) { log(`Artwork ${kind}: HTTP ${res.status}, skipped.`, "WARN"); continue; }
      const buf = Buffer.from(await res.arrayBuffer());

      // Steam picks whichever extension it finds first, so a leftover 1234p.jpg would
      // keep winning over a new 1234p.png. Clear the other extensions for this slot.
      for (const stale of await fs.readdir(gridDir)) {
        if (path.parse(stale).name === base && stale !== path.basename(dest)) {
          await fs.rm(path.join(gridDir, stale), { force: true });
        }
      }
      await fs.writeFile(dest, buf);
      written[kind] = dest;
      log(`  ${kind.padEnd(10)} -> ${path.basename(dest)} (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      log(`Artwork ${kind} failed: ${err.message}`, "WARN");
    }
  }
  return written;
}

// ------------------------------------------------------------------ misc ---

function promptChoice(question, choices, allowSkip = false) {
  return new Promise(resolve => {
    console.log(`\n${question}`);
    choices.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}) ${c}`));
    if (allowSkip) console.log("   0) none of these");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Choice [1-${choices.length}]: `, answer => {
      rl.close();
      const n = Number.parseInt(answer.trim() || "1", 10);
      if (allowSkip && n === 0) return resolve(null);
      resolve(Number.isInteger(n) && n >= 1 && n <= choices.length ? n - 1 : 0);
    });
  });
}

const unquote = s => String(s || "").replace(/^"+|"+$/g, "");
const quote = s => `"${unquote(s)}"`;
const samePath = (a, b) => normalizePathKey(a) === normalizePathKey(b);
const normalizePathKey = s => unquote(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

async function backupShortcuts(shortcutsPath) {
  if (!fsSync.existsSync(shortcutsPath)) return null;
  const dir = path.join(path.dirname(shortcutsPath), "addsteam-backups");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(dir, `shortcuts-${stamp}.vdf`);
  await fs.copyFile(shortcutsPath, dest);

  const kept = (await fs.readdir(dir)).filter(f => f.endsWith(".vdf")).sort().reverse();
  for (const old of kept.slice(10)) await fs.rm(path.join(dir, old), { force: true });
  return dest;
}

async function loadNonsteam() {
  const bundle = path.join(REPO, "dist", "bundle", "index.js");
  if (!fsSync.existsSync(bundle)) {
    throw new UserError(
      `The nonsteam bundle is missing (${bundle}).\n` +
      `Rebuild it with:  cd "${REPO}" && npm install && npm run build:bundle`
    );
  }
  return import(`file://${bundle.replace(/\\/g, "/")}`);
}

// ------------------------------------------------------------------ main ---

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.target && !opts.list)) {
    console.log(USAGE);
    return opts.help ? 0 : 1;
  }

  const { Shortcuts, Entry } = await loadNonsteam();

  const steamPath = await findSteamPath();
  const userId = await findSteamUser(steamPath, opts.user);
  const configDir = path.join(steamPath, "userdata", userId, "config");
  const shortcutsPath = opts.input ? path.resolve(opts.input) : path.join(configDir, "shortcuts.vdf");
  const gridDir = path.join(configDir, "grid");

  if (!fsSync.existsSync(shortcutsPath)) {
    await fs.mkdir(path.dirname(shortcutsPath), { recursive: true });
    await fs.writeFile(shortcutsPath, Buffer.alloc(0));
    log(`Created an empty ${shortcutsPath}.`, "DEBUG");
  }

  // --list is read-only, so it must not disturb a running Steam.
  if (opts.list) {
    const shortcuts = await Shortcuts.load(shortcutsPath);
    const count = shortcuts.entries.length;
    console.log(`\n${count} non-Steam ${count === 1 ? "entry" : "entries"} in ${shortcutsPath}\n`);
    for (const e of [...shortcuts.entries].sort((a, b) => a.appName.localeCompare(b.appName))) {
      console.log(`  ${String(e.appId).padStart(10)}  ${e.appName}`);
    }
    console.log("");
    return 0;
  }

  const exe = await resolveExe(opts.target, opts.pick);
  const startDir = opts.startDir ? path.resolve(opts.startDir) : path.dirname(exe);

  log(`Steam    : ${steamPath} (account ${userId})`);
  log(`Executable: ${exe}`);

  // Resolve the name and artwork before touching Steam, so a failed lookup costs nothing.
  const sgdb = opts.art
    ? new (await import("steamgriddb")).default(process.env.SGDB_API_KEY || DEFAULT_SGDB_KEY)
    : null;

  const candidates = opts.name ? [opts.name] : nameCandidates(exe);
  let appName = candidates[0];
  let match = null;

  if (opts.art) {
    if (opts.sgdbId) {
      match = { id: opts.sgdbId, name: appName, matchScore: 1 };
      log(`Using SteamGridDB id ${opts.sgdbId}.`);
    } else {
      log(`Searching SteamGridDB for "${candidates.join('" / "')}"...`);
      match = await searchSgdb(sgdb, candidates, opts.pick);

      // Three tiers, because the two mistakes cost differently. Artwork from a near-miss
      // is a picture you can replace; a near-miss that renames the entry is the title you
      // then see in your library forever. So the name is only taken from a near-certain
      // match, artwork from a merely good one, and a poor match is refused outright -
      // "Five Night's at Freddy's" scores 90% against "LEGO Five Nights at Freddy's".
      if (!match) {
        log("No SteamGridDB match; adding without artwork.", "WARN");
      } else if (opts.pick || match.matchScore >= 0.92) {
        log(`Match: "${match.name}" (id ${match.id}, ${(match.matchScore * 100).toFixed(0)}%)`);
        if (!opts.name && !opts.keepName) appName = match.name;
      } else if (match.matchScore >= 0.7) {
        log(`Closest match is "${match.name}" (${(match.matchScore * 100).toFixed(0)}%) - keeping the name "${appName}".`, "WARN");
        log("If the artwork is for the wrong game, rerun with --pick or --sgdb-id <id>.", "WARN");
      } else {
        log(`Best match "${match.name}" is only ${(match.matchScore * 100).toFixed(0)}% similar; skipping artwork.`, "WARN");
        log("Rerun with --pick to choose it yourself, or --name to search a better title.", "WARN");
        match = null;
      }
    }
  }

  log(`Game name : ${appName}`);

  const art = (opts.art && match) ? await fetchArtwork(sgdb, match.id, opts.animated) : {};
  if (opts.art && match) log(`Artwork available: ${Object.keys(art).join(", ") || "none"}`);

  if (opts.dryRun) {
    console.log("\n[dry-run] Would write to " + shortcutsPath);
    console.log(JSON.stringify({
      AppName: appName, Exe: quote(exe), StartDir: quote(startDir + path.sep),
      LaunchOptions: opts.launchOptions, tags: opts.tags, AllowOverlay: opts.overlay,
      artwork: Object.fromEntries(Object.entries(art).map(([k, v]) => [k, v.split("/").pop()])),
    }, null, 2));
    return 0;
  }

  // Steam keeps shortcuts.vdf in memory and rewrites it from that copy when it exits, so
  // anything written underneath a running Steam is discarded a few minutes later.
  const steamExe = steamExePath(steamPath);
  const wasRunning = await isSteamRunning();
  let stopped = false;

  if (opts.restartSteam === "never") {
    if (wasRunning) log("Steam is running and --restart-steam=never was given: it will overwrite this change when it exits.", "WARN");
  } else if (wasRunning) {
    stopped = await shutdownSteam(steamExe);
  }

  const backup = await backupShortcuts(shortcutsPath);
  if (backup) log(`Backup: ${backup}`, "DEBUG");

  const shortcuts = await Shortcuts.load(shortcutsPath);
  let entry = opts.force ? undefined : shortcuts.entries.find(e => samePath(e.exe, exe));
  if (!entry && !opts.force) {
    entry = shortcuts.entries.find(e => normalize(e.appName) === normalize(appName));
    if (entry) log(`"${entry.appName}" already exists (id ${entry.appId}) with a different exe; updating it.`, "WARN");
  }

  const isUpdate = Boolean(entry);
  if (entry) {
    entry.setValues({
      appName,
      exe: quote(exe),
      startDir: quote(startDir + path.sep),
      allowOverlay: opts.overlay,
      ...(opts.launchOptions ? { launchOptions: opts.launchOptions } : {}),
      ...(opts.tags.length ? { tags: opts.tags } : {}),
    });
  } else {
    entry = new Entry({
      appName,
      exe: quote(exe),
      startDir: quote(startDir + path.sep),
      launchOptions: opts.launchOptions,
      tags: opts.tags,
      allowOverlay: opts.overlay,
      allowDesktopConfig: true,
    });
    shortcuts.addEntry(entry);
  }

  const appId = entry.appId;

  if (Object.keys(art).length) {
    log(`Downloading artwork to ${gridDir}`);
    const written = await downloadArtwork(art, appId, gridDir);
    if (written.icon) entry.icon = written.icon;
  }
  // With no SGDB icon, pointing at the exe lets Steam use the icon compiled into it.
  if (!entry.icon) entry.icon = exe;

  await shortcuts.save(shortcutsPath);
  log(`${isUpdate ? "Updated" : "Added"} "${appName}" (app id ${appId}).`, "SUCCESS");

  if (stopped || (opts.restartSteam === "always" && !wasRunning)) {
    await startSteam(steamExe);
  } else if (!wasRunning) {
    log("Start Steam to see the game in your library.");
  } else {
    log("Restart Steam to see the game in your library.", "WARN");
  }
  return 0;
}

main()
  .then(code => process.exit(code ?? 0))
  .catch(err => {
    if (err instanceof UserError) log(err.message, "ERROR");
    else log(`${err.message}\n${process.env.ADDSTEAM_DEBUG ? err.stack : ""}`, "ERROR");
    process.exit(1);
  });
