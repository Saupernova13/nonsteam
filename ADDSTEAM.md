# addsteam

Add a non-Steam PC game to Steam, with artwork, from a single path.

```cmd
addsteam "D:\Games\GameHere\Launch.exe"
```

That one command finds the signed-in Steam account, works out the game's name from the
path, looks it up on SteamGridDB, downloads the grid/hero/logo/icon set, writes the
shortcut into `shortcuts.vdf`, and restarts Steam so the game shows up immediately.

A folder works too - the most likely game executable is picked out of it:

```cmd
addsteam "D:\Games\GameHere"
```

`addsteam` is a wrapper around the `nonsteam` library in this repo, which owns the
`shortcuts.vdf` binary format. It adds no dependencies beyond the ones `nonsteam` already
uses.

## Install

```sh
npm install
npm run build:bundle
```

`addsteam` loads the compiled library from `dist/bundle`, so that build step is required
after a fresh clone.

Then put the command on your `PATH`:

- **Windows** - add the repository directory to your user `PATH`; `addsteam.cmd` is picked
  up from there.
- **Linux / Steam Deck** - `ln -s "$PWD/addsteam" ~/.local/bin/addsteam`.

## What it adds over `nonsteam add`

The CLI already writes all five images Steam uses, from URLs, local files, or a
SteamGridDB id. `addsteam` covers the parts around it:

- **Searches SteamGridDB by name.** `nonsteam add --sgdb-id` needs a numeric id, so
  something has to turn "the folder this game is installed in" into that id first.
- **Finds the Steam account without the registry.** `nonsteam` locates accounts through
  `HKCU\SOFTWARE\Valve\Steam\Users`, which is missing on some Windows installs. When it is,
  every command fails with *"Could not find shortcuts file to load"*, and artwork is
  silently skipped because that code path needs a known user. `addsteam` reads
  `ActiveProcess\ActiveUser` instead - the account actually signed in - falls back to the
  most recently used `userdata` folder, and writes the artwork itself.
- **Closes Steam around the write.** A running Steam keeps `shortcuts.vdf` in memory and
  writes its own copy back out when it exits, discarding anything added underneath it.
- **Guesses the name and the executable**, so adding a game is one argument rather than a
  full command line.

## Usage

```
addsteam <exe-or-folder> [options]
addsteam --remove <name-or-appid>
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
| `--remove <name\|appid>` | Delete an entry and its artwork. |

Environment variables: `ADDSTEAM_STEAM_USER` (default `--user`), `ADDSTEAM_STEAM_PATH`
(non-standard Steam install), `SGDB_API_KEY` (your own SteamGridDB key instead of the one
this repo ships), `ADDSTEAM_DEBUG=1` (verbose), `NO_COLOR` (plain output).

## How the name is chosen

The library folders above the game (`D:\Games\PC\...`) and the engine folders below it
(`\Binaries\Win64\`) are dropped, and what is left is the install root - the folder someone
named after the game. Its innermost subfolder and the executable's own name are kept as
backups, because engines put a project codename in between:

```
D:\Games\Hi-Fi RUSH\Hibiki\Binaries\Win64\Hi-Fi-RUSH.exe
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
  inherit administrator. An elevated Steam passes that token to every game and emulator it
  launches, and stays elevated until the next reboot.
- Re-adding a game that is already there updates the existing entry rather than creating a
  duplicate, so its app id, playtime and controller config survive. Use `--force` for a
  genuine second entry.

## Troubleshooting

**"The nonsteam bundle is missing"** - the compiled library was cleaned. Run
`npm install && npm run build:bundle` in the repository.

**The game went to the wrong Steam account** - more than one account exists in `userdata`.
`addsteam` uses the signed-in one; pass `-u <id>` to override, and `addsteam --list -u <id>`
to see what each one holds.

**Wrong artwork** - rerun with `--pick` to choose the SteamGridDB entry, or `--sgdb-id <id>`
if you know it. Re-running updates the entry in place.

**The game is not in the library after adding** - Steam has to be restarted to reread
`shortcuts.vdf`. `addsteam` does that itself unless `--restart-steam never` was passed or
Steam refused to exit within 30 seconds.
