# MOASYS-Vault

**MOASYS-Vault** is a read-only scanner for a [Plex](https://www.plex.tv/) media library. Point it at your media directories and it generates a clean, structured catalog of everything you own and surfaces hygiene issues (naming mismatches, structural problems, duplicates, missing episodes, quality outliers, tag/folder mismatches, and more).

Built for **MOASYS** _(Mossimo's Oasis System)_ and designed to be shared.

> **The scanner never modifies, moves, renames, or deletes media files.** Every check produces warnings only — you do the actual library changes.

---

## Features

- **Works for Movies, Shows, Music, and Audiobooks** out of the box, following Plex's standard folder/file naming conventions.
- **One command catalogs your whole library.** Run `npm run scan:all` and you get a clean JSON catalog of every movie, show, album, and audiobook you own — plus a list of every hygiene issue worth your attention.
- **Catches problems you'd never notice manually.** Folder/file name mismatches, missing episodes, duplicate movies across quality folders, music files whose embedded artist/album info disagrees with their folder, files sitting in the wrong quality bucket — surfaced with recommended fixes.
- **TMDB cross-check (optional).** Compare your movies + shows against [TheMovieDB](https://www.themoviedb.org/) to catch title typos, wrong years, and missing episodes. Sign up for a free TMDB API key to use this feature.
- **Plex tools (optional).** Pull every Plex library's catalog and collections, then compare Plex with what's on disk — files Plex never picked up, stale entries, unmatched or wrongly matched titles, and duplicates — and turn errors from Plex's own logs into warnings on the files they concern. Read-only: Plex is never changed. See [Plex](docs/PLEX.md).
- **Customize without touching code.** Per-type rule files let you adjust how the scanner reads your library, and a per-type ignore list lets you silence warnings you don't want to act on.
- **Never touches your media.** The scanner only reads. Every check produces warnings — you decide what to fix and do the renames/moves yourself.

---

## Requirements

- [Node.js](https://nodejs.org/) v22 or higher (v24 LTS recommended)
- npm (included with Node.js)
- A media library to scan (local folders, external drives, or network shares are all supported)

Optional:

- A free [TMDB API v3 key](https://developer.themoviedb.org/docs/getting-started) for the validate pass
- A Plex Media Server address and token for the Plex tools

---

## Documentation

- **[Configuration](docs/CONFIG.md)** — How to point the scanner at your library and configure rules per media type.
- **[Conventions](docs/CONVENTIONS.md)** — Plex folder and file naming conventions per media type, with examples and gotchas.
- **[Scans](docs/SCANS.md)** — Detailed runbook for the scan and validate passes, including what to re-run when things change.
- **[Output](docs/OUTPUT.md)** — Output file shapes and the complete list of warnings per media type.
- **[Plex](docs/PLEX.md)** — Connecting to your Plex server, pulling library catalogs and collections, comparing Plex with your scans, and reading Plex's logs.

---

## Useful commands

```bash
# Catalog one media type — slow first run, cached after
npm run movies
npm run shows
npm run music
npm run audiobooks

# Catalog all four sequentially
npm run scan:all

# Cross-check movies/shows against TMDB (needs .secrets.json with a TMDB API key)
# and audiobooks against Open Library
npm run validate:movies
npm run validate:shows
npm run validate:audiobooks   # Open Library — no key needed
npm run validate:all

# Pull Plex library catalogs + collections, then compare Plex with your scans
# and read Plex's logs (needs plex.url in config.json and plex.token in .secrets.json)
npm run plex:pull
npm run plex:check
npm run plex:logs

# Repair show filenames the scanner flagged. The one write-capable command —
# dry run by default, and the drive name is required.
npm run fix:shows -- --fix show-prefix external
npm run fix:shows -- --fix episode-titles external --apply
```

If a media type spans several drives, add the drive's name from `config.json`. Leaving it off uses the first root configured for that type:

```bash
npm run movies external
npm run scan:all external
npm run validate:movies external
```

---

## Supported sources

MOASYS-Vault reads from any path your OS can access:

- **Local folders** — any folder on your machine
- **External drives** — USB or Thunderbolt drives mounted to your system
- **Network shares (NAS)** — SMB shares from devices like Synology, QNAP, Ugreen, etc.

If File Explorer (Windows) or Finder (macOS) can see the path, so can the scanner. Per-OS path formats:

| OS      | Example `root_path`                        |
| ------- | ------------------------------------------ |
| Windows | `"Z:\\Movies"` or `"\\\\NAS-NAME\\Movies"` |
| macOS   | `"/Volumes/Movies"`                        |
| Linux   | `"/mnt/nas/Movies"`                        |

---

## Installation

Clone or download this repository, then:

```bash
cd MOASYS-Vault
npm install
```

---

## Quickstart

```bash
# 1. Tell the scanner where your library lives
#    Edit config.json — list a named root per media type you have.
#    A type that spans drives gets one entry per drive.

# 2. First scan — see the "Estimated scan times" table below
npm run scan:all

# 3. Open output/<drive>/<type>/warnings.json, fix what you can, re-scan
#    Re-scans are fast because only new/changed files are re-checked.
```

### Estimated scan times

The first scan is the slow one — the scanner inspects every file to build a cache. After that, only new or changed files get re-checked, so every re-scan finishes in seconds. To force a full re-inspection, delete the matching file under `cache/`.

| Library         | First run |
| --------------- | --------- |
| 2,500 movies    | 12–20 min |
| 5,000 episodes  | 15–25 min |
| 7,000 tracks    | 10 min    |
| 3,500 chapters  | 6 min     |
| Validate movies | ~10 min   |
| Validate shows  | ~3 min    |

For the detailed runbook, see [Scans](docs/SCANS.md).

---

## How it works

When you run `npm run scan:all`, for each media type the scanner does this in order against one drive:

1. **Inspect every primary file.** Reads video dimensions, audio codec/bitrate/sample rate, and (for music and audiobooks) the artist/album/track info embedded in the file. Results are cached, so subsequent runs skip unchanged files.
2. **Walk the folder tree.** Parses every folder and file name against Plex naming conventions to spot mismatches and missing items.
3. **Build the catalog.** Combines the file inspection with the folder/file structure to produce per-type catalogs — each entry lists title, year, where every copy lives, and (if your library is organized by quality) the quality of each copy.
4. **Write three files to `output/<drive>/<type>/`**:
   - `<type>.json` — your clean catalog
   - `probe.json` — the rich per-file inspection data
   - `warnings.json` — every hygiene issue worth your attention

Then, optionally, run `npm run validate:movies` and `npm run validate:shows` to cross-check those types against TheMovieDB for title typos, wrong years, and missing episodes, and `npm run validate:audiobooks` to spell-check book titles and authors against Open Library. **Validation is fully optional** — movies and shows need a free TMDB API key in `.secrets.json`; audiobooks need nothing. The rest of the scanner works without either.

Detailed runbook and re-run scenarios in [Scans](docs/SCANS.md).

---

## Output

Each drive/media-type pair writes its files to its own subfolder inside `output/`:

```text
output/<drive>/<type>/
├── <type>.json
├── probe.json
├── warnings.json
├── validation.json
└── validation-warnings.json
```

`<drive>` is the lowercased `name` of the root from `config.json` — so a two-drive movies library produces `output/server/movies/` and `output/external/movies/`. Drives are never merged.

- **`<type>.json`** — your catalog. Title, year, quality, where each copy lives. This is the file a website or other tool would read.
- **`probe.json`** — the rich detail behind the catalog. Codecs, bitrates, frame rates, sample rates, and embedded music tags. Useful when you want more than the catalog gives you, or for debugging.
- **`warnings.json`** — your hygiene to-do list. Each entry has a `path`, a human-readable `issue`, and (where applicable) a recommended fix.
- **`validation.json` / `validation-warnings.json`** — only appear after `npm run validate:<type>`. Contain TMDB (or, for audiobooks, Open Library) cross-check results and confidence-based warnings.

---

## Project structure

```text
MOASYS-Vault/
├── config.json
├── .secrets.json
├── rules/
├── ignored/
├── output/
├── cache/
├── schemas/
├── docs/
└── src/
```

For day-to-day use, you'll only touch the top few:

- **`config.json`** — the paths to your library: a list of named roots per media type, one per drive. You always edit this.
- **`.secrets.json`** — your TMDB API key and Plex token. Each is only needed by the commands that use it. Gitignored.
- **`rules/`** — per-type rules. Default committed values; override in `rules/<type>.local.yaml` (gitignored) for your library. Rules are per type, shared across drives.
- **`ignored/`** — per-drive, per-type warning silencers. List names by level in `ignored/<drive>/<type>.yaml` (`shows: Firefly (2002)`) to suppress warnings you don't want to act on. Each type ships with a commented `.yaml.example` reference at the top level.
- **`output/`** — generated catalogs + warnings, written every run under `output/<drive>/<type>/`, plus Plex library pulls under `output/plex/`. Gitignored.
- **`cache/`** — file-inspection caches (`cache/<drive>/<type>-probe.json`) and TMDB caches (`cache/tmdb-*.json`, shared across drives). Gitignored. Safe to delete a file under it to force a fresh inspection or fresh TMDB lookup.

The rest is for contributors:

- **`schemas/`** — JSON Schema (Draft 2020-12) definitions for every output file. Useful when building a downstream consumer (e.g. a personal website). See [`schemas/README.md`](schemas/README.md).
- **`docs/`** — detailed reference for each topic (see [Documentation](#documentation) above).
- **`src/`** — TypeScript source. Organized as `core/` (shared scaffolding), `media/` (scan logic per type), `probe/` (ffprobe + ID3), `validate/` (TMDB, Open Library), `plex/` (read-only Plex client, pull, check, and logs), `tools/` (the one write-capable utility), plus `scan.ts` as the entry point.

---

## Recent additions

A terse log of what's landed lately. Not formal release notes — just pointers to "what's new" if you're returning after time away.

- **v0.7** _(breaking)_ — Ignore lists are now keyed by level with bare names (`shows: Firefly (2002)`) instead of a flat list of path prefixes. Names are matched at their level and are category-independent, which finally makes the cross-category checks (`warn_multi_quality`, `warn_duplicate_quality`, `warn_duplicate_album`, `warn_duplicate_book`) silenceable — they report a display label with no category, so no path-based entry could ever reach them. For shows, `Season 3` ≡ `Season 03` and an episode's filename ≡ its `S03E01` code, so one entry covers the scan, probe and validate passes. Per-entry `types:` scoping is gone; use `checks.warn_*: false` to silence a whole warning type. Old-format files fail fast with a migration message.
- **v0.6** — `warnings.json` and `validation-warnings.json` switched to a `by_type` map shape (sparse, alphabetised) instead of a flat `files` array. Run output now prints a per-type breakdown after the totals line. `WarningCollector` gained `groupedByType()` and `countByType()` views; the duplicate `writeWarnings` implementations were unified. JSON Schema files for every output landed under [`schemas/`](schemas/).
- **v0.5** — `acceptable_album_combos` (music) and `acceptable_book_combos` (audiobooks) for whitelisting intentional cross-category duplicates. `warn_mono_audio` (music, default-on, per-album summary). TMDB cache TTL with `--refresh-older-than=Nd` opt-in flag. ffprobe cache orphan cleanup at end of each scan. Lazy rules loading — `npm run movies` only loads the movies rules.
- **v0.4** — Type-scoped `ignored/<type>.yaml` entries: `{path, types: [...]}` alongside the existing bare-string form. TMDB episode-name validation (`warn_tmdb_episode_name_mismatch`, opt-in for multi-episode files via a separate toggle). `warn_missing_episode_title` (opt-out, per-season summary). Music probe paths now include the category prefix. Audiobook duplicate-book path normalised to `Author/Book Title` for parity with music.
- **v0.3** — Every warning carries a stable `type` identifier matching its `warn_*` toggle. Validation-warning paths gained a category prefix when the library is organised by subfolder. All warning paths normalised to forward slashes for cross-OS consistency.

---

## License

MIT
