# addsteam

Add a non-Steam PC game to Steam, with artwork, from a single path.

```cmd
addsteam "C:\Games\GameHere\Launch.exe"
```

That one command finds the signed-in Steam account, works out the game's name from the
path, looks it up on SteamGridDB, downloads the grid/hero/logo/icon set, writes the
shortcut into `shortcuts.vdf`, and restarts Steam so the game shows up immediately.

A folder works too - the most likely game executable is picked out of it:

```cmd
addsteam "C:\Games\GameHere"
```

This is a wrapper around [nonsteam](https://github.com/cameronhimself/nonsteam) (this
repo), which owns the `shortcuts.vdf` binary format. `addsteam` is `scripts/addsteam.mjs`
plus the `addsteam.cmd` shim; the repo directory is on the user `PATH`, so the command
works from any terminal.

## Why not just `nonsteam add`

The upstream CLI does support artwork - `--sgdb-id`, `--image-grid`, `--image-hero` and so
on - but it leaves four things to the caller:

- **It needs a numeric SteamGridDB id.** There is no search by name.
- **It cannot find `shortcuts.vdf` on this machine.** It locates Steam accounts through
  `HKCU\SOFTWARE\Valve\Steam\Users`, a registry key that does not exist here, so
  `nonsteam get` answers *"Could not find shortcuts file to load"*. For the same reason its
  image copy silently does nothing, because that code path is skipped when no Steam user is
  known. `addsteam` resolves the account from `ActiveProcess\ActiveUser` and writes the
  artwork itself.
- **It does not restart Steam.** A running Steam keeps `shortcuts.vdf` in memory and writes
  its own copy back out when it exits, discarding anything added underneath it.
- **It has no name or executable guessing**, so every add is a full command line.

## Usage

```
addsteam <exe-or-folder> [options]
addsteam --list
addsteam --help
```

| Option | Meaning |
| - | - |
| `-n, --name <name>` | Set the name instead of deriving it from the path. |
| `--keep-name` | Keep the derived name even when SteamGridDB knows a better one. |
| `--sgdb-id <id>` | Use a specific SteamGridDB game id, skipping the search. |
| `--pick` | Choose the SteamGridDB match (and the executable, if ambiguous) yourself. |
| `--no-art` | Add the entry without downloading artwork. |
| `--animated` | Allow animated artwork. Static only by default. |
| `-d, --start-dir <dir>` | Working directory. Defaults to the executable's folder. |
| `-o, --launch-options <s>` | Steam launch options, e.g. `PROTON_LOG=1 %command%`. |
| `-t, --tags <a,b,c>` | Steam collections/tags. |
| `--no-overlay` | Turn the Steam overlay off for this entry. |
| `-u, --user <steamid32>` | Target a specific `userdata` account. |
| `-i, --input <path>` | Use a specific `shortcuts.vdf`. |
| `--restart-steam <mode>` | `auto` (default), `never`, `always`. |
| `--force` | Add a second entry even if the game is already there. |
| `--dry-run` | Show what would happen and change nothing. |
| `--list` | List the non-Steam entries already in Steam. |

Environment variables: `ADDSTEAM_STEAM_USER` (default `--user`), `ADDSTEAM_STEAM_PATH`
(non-standard Steam install), `SGDB_API_KEY` (your own SteamGridDB key instead of the one
nonsteam ships), `ADDSTEAM_DEBUG=1` (verbose).

## How the name is chosen

The library folders above the game (`H:\Games\PC\...`) and the engine folders below it
(`\Binaries\Win64\`) are dropped, and what is left is the install root - the folder someone
named after the game. Its innermost subfolder and the executable's own name are kept as
backups, because engines put a project codename in between:

```
C:\Games\Hi-Fi RUSH\Hibiki\Binaries\Win64\Hi-Fi-RUSH.exe
         ^install root  ^codename                ^exe name
```

All three are searched on SteamGridDB and the best match wins. Queries are split on case
boundaries first (`FiveNightsatFreddys` -> `Five Nightsat Freddys`), because SteamGridDB's
search is nearly literal and returns nothing at all for a run-together name.

What happens to the match depends on how good it is:

| Confidence | Result |
| - | - |
| 92% or better | Artwork downloaded, entry named after the SteamGridDB title. |
| 70% - 92% | Artwork downloaded, derived name kept, warning printed. |
| below 70% | No artwork, warning printed. |

The split exists because the two mistakes cost differently: artwork for a near-miss is a
picture you can replace, while a near-miss that renames the entry is the title you then see
in your library forever. `"Five Night's at Freddy's"` scores 90% against *LEGO Five Nights
at Freddy's*, which is a different game.

Override any of it with `--name`, `--sgdb-id`, or `--pick`.

## Safety

- `shortcuts.vdf` is copied to `userdata/<id>/config/addsteam-backups/` before every write,
  and the last ten backups are kept.
- Steam is closed before the write and restarted after (`--restart-steam auto`), because a
  running Steam would otherwise overwrite the change on exit. With `--restart-steam never`
  and Steam running, that risk is printed as a warning.
- If the shell is elevated, Steam is relaunched through `explorer.exe` so it does not
  inherit administrator - an elevated Steam breaks emulators launched from it, and stays
  elevated until the next reboot.
- Re-adding a game that is already there updates the existing entry rather than creating a
  duplicate, so its app id, playtime and controller config survive. Use `--force` for a
  genuine second entry.

## Troubleshooting

**"The nonsteam bundle is missing"** - the compiled library was cleaned. Rebuild it:

```cmd
cd C:\Users\RaaViVi\Documents\github\nonsteam
npm install
npm run build:bundle
```

**The game went to the wrong Steam account** - there is more than one account in
`userdata`. `addsteam` uses the signed-in one; pass `-u <id>` to override, and
`addsteam --list -u <id>` to check what is in each.

**Wrong artwork** - rerun with `--pick` to choose the SteamGridDB entry, or
`--sgdb-id <id>` if you know it. Re-running updates the entry in place.

**The game is not in the library after adding** - Steam has to be restarted to reread
`shortcuts.vdf`. `addsteam` does that itself unless `--restart-steam never` was passed or
Steam refused to exit within 30 seconds.

`scripts/add-game.ts` is an earlier version of this idea and is superseded by
`scripts/addsteam.mjs`.
