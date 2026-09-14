# Working on MOASYS-Vault

Context for Claude (and any other AI assistant) when working in this repo.

## Hard rule: READ-ONLY access to media files

**The scanner — and you while modifying it — must never modify, move, rename, or delete files under any user's `root_path`.** The user owns all changes to their media library.

This rule applies to every root listed in `config.json`. Each media type is an array of `{root_path, name}` entries — one per drive:

- Movies (`config.movies[]` — `M:\Movies` "Server", `D:\Movies` "External")
- Shows (`config.shows[]` — `M:\Shows` "Server", `D:\Shows` "External")
- Music (`config.music[]` — `M:\Audio` "Server")
- Audiobooks (`config.audiobooks[]` — `M:\Audiobooks` "Server")
- Any other path configured in `config.json`

What the scanner does instead: **emits warnings** in `output/<drive>/<type>/warnings.json` describing what it would suggest changing, with recommended fixes. The user reads the warnings and does the actual filesystem changes themselves.

What this means for you when working in this repo:

- Never write code that calls `fs.rename`, `fs.unlink`, `fs.rmdir`, `fs.cp`, `fs.writeFile`, etc. against any path derived from `config.<type>.root_path`.
- Never suggest a "fix-up script" or "rename helper" that auto-corrects library issues. Even if it would be useful. Warnings only.
- If a user asks for an auto-fix feature, decline with the rationale: the read-only constraint is a deliberate safety guarantee. The single exception below is already built — point them at it rather than writing a second one.
- Reading is fine. `fs.readdir`, `fs.stat`, `fs.readFile` against media files (ffprobe metadata, ID3 tags, etc.) is the expected pattern.

Project files (source code, rules YAMLs, `config.json`, README, etc.) are fair game — that constraint only applies to the user's media library.

### The one sanctioned exception: `src/tools/rename-shows.ts`

`npm run fix:shows` is the **only** code in this repo permitted to write to a media library, added deliberately for batches of thousands of files that are impractical to fix by hand. It is not a loophole in the rule above — it is a single, audited, opt-in tool, and the rule still holds everywhere else. **Do not add a second writer, and do not widen this one, without the user explicitly asking.** In particular the scanner, probe, and validate passes stay strictly read-only.

Its guarantees, all of which must survive any change you make to it:

- **Renames files, nothing else.** `fs.renameSync` file → file inside one directory. No `unlink`, `rmdir`, `cp`, or content write; folder names are never touched.
- **The drive name is mandatory** — it reuses `resolveRoot()` but deliberately drops the default-to-first-root fallback the scan runners have, so a forgotten argument can't silently target the primary server.
- **Dry run unless `--apply`.** Every run writes the full plan to `output/<drive>/shows/rename-plan.json` first.
- **All-or-nothing on unsafe entries.** Collisions, illegal characters, or over-long paths abort before the first rename; a season is never left half-renamed. Files with no data are _skipped_, which is separate and non-blocking.
- **An undo manifest is written before the first rename**, replayable with `--undo`.
- **Case-only renames go through a two-step temporary name.** See `renameFile()` — a plain `fs.renameSync` is a silent no-op for these on case-insensitive filesystems, and the user's External drive is exFAT. This bit once: a run reported 726 successful renames while leaving 174 files untouched.

After any `--apply`, verify against the filesystem rather than trusting the tool's own success count.

### Naming warnings vs. capitalization warnings

Several checks compare a filename or tag against its parent folder. These deliberately come in pairs — a strict check for genuinely different values and a separate, lower-severity check for capitalization-only drift, so cosmetic noise can't bury a real mismatch:

| Type                       | Different value                                          | Capitalization only                              |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Shows                      | `warn_show_year_mismatch`                                | `warn_show_title_case`                           |
| Movies                     | `warn_title_mismatch`                                    | `warn_title_case`                                |
| Music                      | `warn_folder_tag_mismatch`                               | `warn_folder_tag_case`                           |
| Audiobooks (book vs book)  | `warn_series_name_mismatch`, `warn_author_name_mismatch` | `warn_series_name_case`, `warn_author_name_case` |
| Audiobooks (tag vs folder) | `warn_book_tag_mismatch`, `warn_author_tag_mismatch`     | `warn_book_tag_case`, `warn_author_tag_case`     |
| Audiobooks (Open Library)  | `warn_openlibrary_title_mismatch`                        | `warn_openlibrary_title_case`                    |

The precedent is `warn_tmdb_title_canonical`, which has always been case-sensitive and separate. If you add another folder-vs-file comparison, follow the same split — a bare `.toLowerCase()` comparison makes case drift permanently invisible, which is exactly how 174 files went unreported for months.

## What this project is

A read-only scanner for a Plex media library. Two purposes:

1. Build a clean JSON catalog of movies / shows / music / audiobooks for a future personal website.
2. Surface library hygiene issues (naming mismatches, structural problems, missing files, duplicates, etc.) so the user can fix them manually.

The user already has Plex; the point isn't to replicate Plex's functionality. It's a side project focused on library hygiene + catalog generation.

## Architecture in one paragraph

`config.json` carries per-machine "where" data — an array of named roots (`{root_path, name}`) per media type, validated by Zod in `src/core/config.ts`. `rules/<type>.yaml` carries "how" data (regex patterns, file extensions, naming conventions, per-warning toggles, the `categories` list of subfolders to walk). Each media module (`src/media/<type>.ts`) is a **factory** that takes the validated rules and returns a `MediaModule` object. The merged runner `src/scan.ts` resolves the requested drive, then per type: loads the probe cache, runs `probe<Type>` (ffprobe + ID3 for music), then calls `scan()` in `src/core/scanner.ts` which iterates `module.getCategories()` and calls `module.scanCategory()` for each — passing a `probeByPath` map so movies/shows derive each version's quality from ffprobe dimensions via `deriveQuality()`. One run produces `<type>.json` (catalog with `versions: [{category, quality}]`), `probe.json` (rich raw data), and `warnings.json` (everything from both passes). Validation is via Zod in `src/core/rules/`.

**Multi-drive.** A run targets exactly one root, named positionally (`npm run movies external`) or defaulting to the first entry in that type's array. Everything drive-specific is namespaced by `driveSlug(name)` (lowercased): `output/<drive>/<type>/`, `cache/<drive>/<type>-probe.json`, `ignored/<drive>/<type>.yaml`. TMDB caches stay un-sharded at `cache/tmdb-*.json` — keyed by title/year, not path. Drives are never merged and there are no cross-drive checks. Below the runner nothing knows about drives: `MoviesConfig` and friends stay aliases of `BaseMediaConfig` (`{root_path}`), which a `MediaRootConfig` satisfies structurally, so `scanner.ts`, the probe walkers, and the media modules took no changes. `resolveRoot()` / `rootNames()` in `src/core/runner-shared.ts` are shared by both runners; an unknown drive name errors on a single-type run and `[SKIP]`s under `--all`.

**Quality auto-detection** (movies + shows): each category's name is scanned for the whole-word substring `UHD`/`HD`/`SD` (case-insensitive, UHD-first) via `detectQuality` in `src/core/rules/helpers.ts`. The resolved `ResolvedCategory.quality` powers both the `warn_quality_mismatch` check (via `classifyQuality`) and the `warn_multi_quality` duplicate-across-qualities check (per-movie for movies, per-season for shows). Categories without a UHD/HD/SD substring resolve to `quality: null` and behave as general tags — no quality checks apply. See [docs/CONFIG.md](docs/CONFIG.md) "Three configuration shapes" for the user-facing explanation.

## Rules system

Three-tier merge for each media type:

```text
code defaults  →  rules/<type>.yaml  →  rules/<type>.local.yaml  →  Zod-validated result
```

- **Code defaults** live in `src/core/rules/<type>.ts` alongside the Zod schema. Neutral / universal — no library-specific values.
- **`rules/<type>.yaml`** is the committed snapshot of code defaults, every option visible and uncommented. Edit to change project-wide defaults. Commit-friendly.
- **`rules/<type>.local.yaml`** is the gitignored personal-overrides file. Library-specific values (extra categories, custom quality_thresholds, personal ignored_season_names) live here.
- **`ignored/<drive>/<type>.yaml`** (in its own `ignored/` folder, not `rules/`) is the user's way of permanently silencing warnings they can't or don't want to fix. Entries are **bare names grouped by the level they name** (`LEVEL_KEYS` in `src/core/ignored.ts`: `folders`/`movies`/`files` for movies, `folders`/`shows`/`seasons`/`episodes` for shows, and so on). A name is matched **exactly at its level and independently of category**, so `shows: Firefly (2002)` silences that show wherever it lives. The deepest level and `seasons` require a parent qualifier; a `/` in an entry means "somewhere above", not "immediately above". An entry silences every warning at or below its level — there is no per-warning-type scoping. Scoped per drive because warning paths are relative to that drive's `root_path`. Each type ships a committed `ignored/<type>.yaml.example` reference at the top level; the real per-drive files are gitignored.

The loader (`src/core/rules/loader.ts`) deep-merges the layers, resolves the `'current'` sentinel for year ranges, validates with Zod, and prints boot-time messages distinguishing each layer:

- `[RULES] Loaded rules/<type>.yaml + N override(s) from rules/<type>.local.yaml`
- `[RULES] Loaded rules/<type>.yaml (no local overrides)`
- `[RULES] Using code defaults (no rules/<type>.yaml found)`

## Warnings philosophy

Every check emits warnings only. Never auto-fix. Warning messages should include a **recommended fix** when possible (see existing `warn_loose_files` / `warn_quality_mismatch` messages for the pattern). Each warning is gated by a `rules.checks.warn_*` toggle so the user can silence noise.

Each call to `warnings.add(type, path, issue, options?)` passes a stable `type` — almost always the matching `warn_*` identifier from the rules schema. The exceptions are filesystem-level failures that aren't user-toggleable (e.g. `permission_denied`). The `type` becomes the bucket key under `by_type` in `warnings.json` and the `checks` toggle name; ignore lists no longer reference it. If you add a new check, the `type` string must equal the rules toggle name. `WarningCollector` exposes three views: `all()` for a flat sorted list (used by tests + per-type summary), `groupedByType()` for the on-disk shape, and `countByType()` for the run-output breakdown.

**If your check's `path` is a display label rather than a real category-anchored library path, pass `options.scope`.** `deriveScope` reads a warning's level chain off its path, which is right for 84 of the ~91 call sites; the rest — the four duplicate-copy checks, which span categories and so carry none, and the TMDB episode-name check, whose last segment is an `S03E01` code where a filename would sit — would be read at the wrong level and become unsilenceable. Spelling out `{categories, levels}` is also what lets a `folders:` entry reach a check that spans categories.

## Useful commands

```bash
npm run movies        # Probe + scan one media type, first configured drive
npm run movies external   # ...against the root named "External"
npm run shows
npm run music
npm run audiobooks
npm run scan:all      # All four sequentially
npm run scan:all external # ...for every type that has an "External" root

npm run validate:movies            # TMDB validation (movies + shows)
npm run validate:movies external
npm run validate:audiobooks        # Open Library validation — no API key
npm run validate:all

# The one write-capable command. Dry run by default; drive name is required.
npm run fix:shows -- --fix show-prefix external          # preview
npm run fix:shows -- --fix episode-titles external --apply
npm run fix:shows -- --undo output/external/shows/rename-undo-<ts>.json

npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run lint:fix
```

npm forwards bare positionals, so the drive name needs no `--` separator.

The smoke test pattern is to run the scan against the user's real library and confirm entry counts + warning counts don't regress. `M:\` is "Server" (the full library, all categories); `D:\` is "External" (movies + shows only, `HD`/`SD` categories).

## Don't waste tokens

The user's library: ~2,500 movies, ~130 shows, ~220 music albums, ~110 audiobooks. With the probe cache primed (which it already is on this machine), all four scans finish in seconds. A FULL first-run probe over movies would be 12–20 min — but the cache should always be warm here. If you must invalidate the cache, do it deliberately. Cache files live at `cache/<drive>/<type>-probe.json`.

When making bulk changes across all 4 media types, use `Edit` with `replace_all: true` rather than reading each file separately. Most cross-cutting changes have an identical shape per file.

## Roadmap (in `README.md` under `## Roadmap`)

The three big-ticket items are all shipped:

- **Music quality summary** — per-album `audio_quality_summary` in `output/music/probe.json` (`"FLAC 16/44.1"`, `"MP3 ~288"`). VBR tolerance collapses same-codec same-quality-target tracks into one entry.
- **ID3 tag reading for music** — per-track `tags` in `output/music/probe.json` via `music-metadata`. Four warnings: compilation_detected, folder_tag_mismatch, missing_tags, track_number_mismatch.
- **TMDB validation for movies + shows** — `npm run validate:movies` / `validate:shows`. Cross-checks titles, years, and (for shows) per-season episode counts. API key in `.secrets.json` (gitignored). Cache in `cache/tmdb-*.json`.

Future ideas not formally on the roadmap: deeper music quality analysis (per-track bitrate distribution, encoding metadata), audiobook chapter/duration validation, custom user-defined checks via a DSL.

## Documentation layout

Docs are split between README and `docs/`. When the user asks something or you need to point them at existing docs, use this map:

- **README.md** — quickstart, the three passes overview, project structure, roadmap
- **docs/CONFIG.md** — `config.json` + `rules/<type>.yaml` reference, override mechanism, `.secrets.json` setup
- **docs/CONVENTIONS.md** — Plex folder/file naming per media type (hierarchies, examples, gotchas)
- **docs/SCANS.md** — Runbook for scan / probe / validate. Suggested workflow + re-run scenarios.
- **docs/OUTPUT.md** — Output file shapes + complete warning tables per media type

When you add a new feature/warning/rule, update the relevant docs/ file AND any related warning table. Don't put deep reference content in README — it's intentionally lean.

## External references

- Plex naming: [Movies](https://support.plex.tv/articles/200381023-naming-movie-files/), [TV](https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/), [Music](https://support.plex.tv/articles/200265296-adding-music-media-from-folders/)
