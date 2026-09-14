# MOASYS-Vault

**MOASYS-Vault** is a read-only scanner for a [Plex](https://www.plex.tv/) media library. Point it at your movies, shows, music, and audiobooks and it builds a clean JSON catalog of everything you own, plus a to-do list of hygiene issues: naming mismatches, missing episodes, duplicates, files in the wrong quality folder, tags that disagree with folders, and more.

Built for **MOASYS** _(Mossimo's Oasis System)_ and designed to be shared.

> **The scanner never modifies, moves, renames, or deletes media files.** Every check produces warnings with a recommended fix — you make the changes.

## Features

- **Movies, shows, music, and audiobooks**, checked against Plex's naming conventions.
- **One command for everything routine** — `npm run all` scans, validates, and compares with Plex, skipping whatever you haven't set up.
- **Problems you'd never spot by hand** — episode gaps, duplicate copies across quality folders, a 480p file in your HD folder, album tags that fragment an artist in Plex.
- **Optional cross-checks** against [TheMovieDB](https://www.themoviedb.org/) (free API key) and [Open Library](https://openlibrary.org/) (no key) for title typos, wrong years, and missing episodes.
- **Optional Plex tools** — find files Plex never picked up, stale entries, wrong matches, and errors from Plex's own logs. Read-only against Plex too.
- **Configurable without code** — rules files per media type, and ignore lists to silence what you've decided to live with.

## Requirements

- [Node.js](https://nodejs.org/) 22.12 or newer (24 LTS recommended)
- A media library on a local folder, external drive, or network share — anything your OS can open

## Quickstart

```bash
git clone https://github.com/SergeantMossimo/MOASYS-Vault.git
cd MOASYS-Vault
npm install

# Tell the scanner where your library lives — edit the paths, drop types you don't have
cp config.example.json config.json

# First scan — slow once while every file is inspected, fast after that
npm run scan:all
```

Then open `output/<drive>/<type>/warnings.json`, fix what you want to fix, and re-scan. [Scans](docs/SCANS.md) walks through the full workflow, including validation and Plex setup.

## Commands

| Command                                     | What it does                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run all [drive]`                       | Everything routine: scan → validate → Plex pull → Plex check                                   |
| `npm run scan:all [drive]`                  | Scan all four media types                                                                      |
| `npm run <type> [drive]`                    | Scan one type: `movies`, `shows`, `music`, `audiobooks`                                        |
| `npm run validate:all [drive]`              | Cross-check against TMDB (movies, shows) and Open Library (audiobooks); also `validate:<type>` |
| `npm run plex:pull`                         | Download every Plex library's catalog and collections                                          |
| `npm run plex:check [drive]`                | Compare the Plex pull with your scans                                                          |
| `npm run plex:logs [drive]`                 | Turn errors from Plex's logs into warnings on the files they concern                           |
| `npm run fix:shows -- --fix <mode> <drive>` | Repair flagged show filenames — the one command that renames files; dry run unless `--apply`   |

`[drive]` is a root's `name` from `config.json`; leave it off to use the first root for each type.

## Documentation

| Guide                              | Covers                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| [Scans](docs/SCANS.md)             | The workflow, what each pass does, scan times, validation, and fixing show filenames      |
| [Configuration](docs/CONFIG.md)    | `config.json`, rules files, ignore lists, and `.secrets.json`                             |
| [Conventions](docs/CONVENTIONS.md) | How Plex expects folders and files to be named, per media type                            |
| [Output](docs/OUTPUT.md)           | Every output file, its shape, and every warning the scanner can emit                      |
| [Plex](docs/PLEX.md)               | Connecting to Plex, pulling libraries, comparing with your scans, and reading Plex's logs |
| [Changelog](CHANGELOG.md)          | What's changed between versions                                                           |
| [Schemas](schemas/README.md)       | JSON Schemas for every output file, for building on top of the catalog                    |

## Project folders

| Folder / file   | What it's for                                                                     | Committed?    |
| --------------- | --------------------------------------------------------------------------------- | ------------- |
| `config.json`   | Where your library lives — copy from `config.example.json`                        | No            |
| `.secrets.json` | TMDB key and Plex token — copy from `.secrets.json.example`                       | No            |
| `rules/`        | How your library is organized; personal overrides go in `rules/<type>.local.yaml` | Defaults only |
| `ignored/`      | Per-drive lists of warnings to silence                                            | Examples only |
| `output/`       | Catalogs and warnings, rewritten every run                                        | No            |
| `cache/`        | File-inspection and lookup caches — delete a file to force a refresh              | No            |

## Contributing

`npm run check` runs everything CI runs: typecheck, lint, tests, and formatting checks. [CLAUDE.md](CLAUDE.md) describes the architecture and the project's hard rules — above all, that nothing but `fix:shows` ever writes to a media library.

## License

MIT
