# Working on MOASYS-Vault

Context for Claude (and any other AI assistant) when working in this repo.

## Hard rule: READ-ONLY access to media files

**The scanner — and you while modifying it — must never modify, move, rename, or delete files under any user's `root_path`.** The user owns all changes to their media library.

This rule applies to every root listed in `config.json`. Each media type is an array of `{root_path, name}` entries — one per drive (`config.movies[]`, `config.shows[]`, `config.music[]`, `config.audiobooks[]`). `config.json` is gitignored and per-machine; read it for the current roots rather than assuming. `config.example.json` is the committed template.

What the scanner does instead: **emits warnings** in `output/<drive>/<type>/warnings.json` describing what it would suggest changing, with recommended fixes. The user reads the warnings and does the actual filesystem changes themselves.

What this means for you when working in this repo:

- Never write code that calls `fs.rename`, `fs.unlink`, `fs.rmdir`, `fs.cp`, `fs.writeFile`, etc. against any path derived from `config.<type>.root_path`.
- Never suggest a "fix-up script" or "rename helper" that auto-corrects library issues. Even if it would be useful. Warnings only.
- If a user asks for an auto-fix feature, decline with the rationale: the read-only constraint is a deliberate safety guarantee. The single exception below is already built — point them at it rather than writing a second one.
- Reading is fine. `fs.readdir`, `fs.stat`, `fs.readFile` against media files (ffprobe metadata, ID3 tags, etc.) is the expected pattern.

Project files (source code, rules YAMLs, `config.json`, README, etc.) are fair game — that constraint only applies to the user's media library.

### No exceptions

There used to be one: `npm run fix:shows` (`src/tools/rename-shows.ts`), a renaming tool for batches too large to fix by hand. It was removed in 0.23 at the user's request so that the app is read-only without qualification. **Do not reintroduce a writer — not a rename helper, not a "dry run by default" tool — unless the user explicitly asks.** If they do, the old tool (last at commit `8e7515a`) shows the safety model it needed: dry run unless `--apply`, a mandatory drive name, an undo manifest written before the first rename, all-or-nothing validation, and a two-step rename for case-only changes on case-insensitive filesystems.

The rule is enforced in code, not only here: every file the app writes goes through `writeFileAtomic()` (`src/core/atomic-write.ts`), which throws for any path outside the project folder (or the OS temp folder the tests use). Don't write files any other way.

### Naming warnings vs. capitalization warnings

Several checks compare a filename or tag against its parent folder. These deliberately come in pairs — a strict check for genuinely different values and a separate, lower-severity check for capitalization-only drift, so cosmetic noise can't bury a real mismatch:

| Type                        | Different value                                          | Capitalization only                              |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Shows                       | `warn_show_year_mismatch`                                | `warn_show_title_case`                           |
| Movies                      | `warn_title_mismatch`                                    | `warn_title_case`                                |
| Music                       | `warn_folder_tag_mismatch`                               | `warn_folder_tag_case`                           |
| Audiobooks (book vs book)   | `warn_series_name_mismatch`, `warn_author_name_mismatch` | `warn_series_name_case`, `warn_author_name_case` |
| Audiobooks (tag vs folder)  | `warn_book_tag_mismatch`, `warn_author_tag_mismatch`     | `warn_book_tag_case`, `warn_author_tag_case`     |
| Audiobooks (Open Library)   | `warn_openlibrary_title_mismatch`                        | `warn_openlibrary_title_case`                    |
| Plex (Plex title vs folder) | `warn_plex_title_mismatch`                               | `warn_plex_title_case`                           |

The precedent is `warn_tmdb_title_canonical`, which has always been case-sensitive and separate. If you add another folder-vs-file comparison, follow the same split — a bare `.toLowerCase()` comparison makes case drift permanently invisible, which is exactly how 174 files went unreported for months.

## What this project is

A read-only scanner for a Plex media library. Two purposes:

1. Build a clean JSON catalog of movies / shows / music / audiobooks for a future personal website.
2. Surface library hygiene issues (naming mismatches, structural problems, missing files, duplicates, etc.) so the user can fix them manually.

The user already has Plex; the point isn't to replicate Plex's functionality. It's a side project focused on library hygiene + catalog generation.

## Architecture in one paragraph

`config.json` carries per-machine "where" data — an array of named roots (`{root_path, name}`) per media type, validated by Zod in `src/core/config.ts`. `rules/<type>.yaml` carries "how" data (regex patterns, file extensions, naming conventions, per-warning toggles, the `categories` list of subfolders to walk). Each media module (`src/media/<type>.ts`) is a **factory** that takes the validated rules and returns a `MediaModule` object. The merged runner `src/scan.ts` resolves the requested drive, then per type: loads the probe cache, runs `probe<Type>` (ffprobe + ID3 for music), then calls `scan()` in `src/core/scanner.ts` which iterates `module.getCategories()` and calls `module.scanCategory()` for each — passing a `probeByPath` map so movies/shows derive each version's quality from ffprobe dimensions via `deriveQuality()`. Both passes take the same per-run `DirReader` (`src/core/dir-reader.ts`), which memoizes directory listings so the scan reads what the probe already listed — list folders through it, not `fs.readdirSync`, in any walker. After the categories, `scan()` runs `warn_unlisted_folder` over `root_path` (gated by the module's `warnUnlistedFolders`), so a folder missing from `categories` is never silently skipped. One run produces `<type>.json` (catalog with `versions: [{category, quality}]`), `warnings.json` (everything from both passes), and `data/probe.json` (rich raw data). Validation is via Zod in `src/core/rules/`.

**Output layout.** `src/core/output-paths.ts` (`typeOutputPaths()`) is the single source for every per-drive, per-type output path — use it rather than joining `output/` paths by hand. The top of `output/<drive>/<type>/` holds only what the user opens: the catalog, one warnings file per command (`warnings.json`, `validation-warnings.json`, `plex-warnings.json`, `plex-log-warnings.json`), and `all-warnings.json` — the merged report `npm run report` builds from those four, and the only warnings file anything reads back. Data other commands read goes in `data/` (`probe.json`, `validation.json`), `--no-ignore` output in `unfiltered/`. Runners call `reportLegacyOutputFiles()` to point at files older versions left behind (the old flat layout, the removed `fix:shows`'s `fixes/`); it never deletes them.

**Multi-drive.** A run targets exactly one root, named positionally (`npm run movies external`) or defaulting to the first entry in that type's array. Everything drive-specific is namespaced by `driveSlug(name)` (lowercased): `output/<drive>/<type>/`, `cache/<drive>/<type>-probe.json`, `ignored/<drive>/<type>.yaml`. TMDB caches stay un-sharded at `cache/tmdb-*.json` — keyed by title/year, not path. Drives are never merged and there are no cross-drive checks. Below the runner nothing knows about drives: `MoviesConfig` and friends stay aliases of `BaseMediaConfig` (`{root_path}`), which a `MediaRootConfig` satisfies structurally, so `scanner.ts`, the probe walkers, and the media modules took no changes. Every media type in `config.json` is optional (at least one required) — read root lists through `rootsFor(config, type)`, never `config[type]` directly. `probe_concurrency` (per root, default 1) is the one field below the runner that comes from config: it reaches `probeBatch()` through `BaseMediaConfig`.

**Shared runner plumbing.** Every CLI entry point uses the same pieces rather than re-implementing them: `PROJECT_ROOT` and `MEDIA_TYPES` from `src/core/project.ts`; `loadTypeRules(type)` from `src/core/rules/registry.ts` (memoized — never call `loadRules()` with a schema by hand); and from `src/core/runner-shared.ts`, `selectRoot()` (an unknown drive or unconfigured type errors on a single-type run and `[SKIP]`s under `--all`), `rootPathAvailable()` (a missing `root_path` stops the run before anything is written — scanning it would produce an empty catalog and prune the whole probe cache; call it in any new command that reads a root), `printBanner()`, and `printRunSummary()`. `ProbeCache.pruneOrphans()` also refuses to prune when the root is missing and keeps entries under missing category folders. Cache and output files are written with `writeFileAtomic()` (`src/core/atomic-write.ts`) so an interrupted run can't truncate the probe cache; it refuses any path outside the project. Every runner parses its arguments with `parseRunnerArgs(types, extraFlags)`, which rejects an unknown flag or a second drive name — pass the command's own flags (`--no-ignore`) as `extraFlags`. Progress lines come from `progressLogger(tag)`. `npm run all` (`src/run-all.ts`) chains scan → validate → plex pull → plex check → report as child processes. The report runs last so it folds in what the earlier steps just wrote; it is also the one runner that deliberately skips `rootPathAvailable()`, since it reads only `output/` and so works with the drive unplugged.

**Quality auto-detection** (movies + shows): each category's name is scanned for the whole-word substring `UHD`/`HD`/`SD` (case-insensitive, UHD-first) via `detectQuality` in `src/core/rules/helpers.ts`. The resolved `ResolvedCategory.quality` powers both the `warn_quality_mismatch` check (via `classifyQuality`) and the `warn_multi_quality` duplicate-across-qualities check (per-movie for movies, per-season for shows). Categories without a UHD/HD/SD substring resolve to `quality: null` and behave as general tags — no quality checks apply. See [docs/CONFIG.md](docs/CONFIG.md) "Choosing a layout" for the user-facing explanation.

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

Every check emits warnings only. Never auto-fix. Each warning is gated by a `rules.checks.warn_*` toggle so the user can silence noise.

Each call to `warnings.add(type, path, issue, options?)` passes a stable `type` — almost always the matching `warn_*` identifier from the rules schema. The exceptions are filesystem-level failures that aren't user-toggleable (e.g. `permission_denied`). The `type` becomes a row's `type` on disk and the `checks` toggle name; ignore lists no longer reference it. If you add a new check, the `type` string must equal the rules toggle name. `WarningCollector` exposes three views: `all()` for a flat sorted list (used by tests + per-type summary), `groupedByFolder()` for the on-disk shape, and `countByType()`/`tallyByType()` for the run-output breakdown and the file's `by_type`.

**Warnings are grouped on disk by the top-level folder they concern, not by type** — one show is one entry, however many checks fired on it, because that's the unit the user works in. `groupedByFolder()` derives the folder from the scope `add()` already computed via `deriveScope`: `scope.levels[0]` is the show / movie / artist / author. A row's `path` is **relative** to its folder's, and absent entirely when the row is about the folder itself. Rows sort by canonical relative path (via `canonicalName`, so a scan's `Season 03` lands beside a TMDB pass's `Season 3`), then type, then issue.

A folder entry is `{path, count, rows}` and nothing else — no field restates another. Its name is the last segment of `path`, its category the first, and its distinct types are one pass over `rows`; all three were written out per folder until they were measured at 13–18% of every warnings file. `mergeWarnings` keys on the case-folded `path` for the same reason, which is exactly equivalent to the old category-plus-name key because level-1 canonicalization is a plain case fold. **If you add a field here, it has to say something `path` and `rows` don't.**

**`issue` states the fact, and the fact is all that's written.** Two things are deliberately _not_ in the warnings files, both because they were identical on every row of a type and so buried the facts that differ (repeated per row, the remedy alone was 43% of all warning text, and rows averaged 264 characters):

- **The remedy.** `options.fix` is still accepted so call sites document their remedy where the check lives, but nothing writes it. **The warning tables in `docs/OUTPUT.md` are its home** — when you add or change a check, that table row is the deliverable, not a string in the output. Keep a type's text in the file's `FIX` map (see `src/media/shows.ts`) so every call site shares one wording.
- **Ready-to-paste ignore entries.** They were removed from the output, and the function that built them (`suggestIgnoreEntry`) with them in 0.23. Ignore _matching_ (`isWarningIgnored`) is untouched and essential.

So, for an `issue`:

- **Keep it to the facts that differ row to row.** A per-row suggestion (a suggested folder name, say) is a fact and belongs here; generic advice belongs in the docs table. Don't tell the user how to silence a check — the row's `type` and the last segment of the folder's `path` already give them what an ignore entry needs.
- **Don't restate the type.** No leading `Quality mismatch —` or `Folder/tag mismatch:`.
- **Don't restate the folder.** The entry above the row already names the show; lead with what's specific to the row.
- **Lead with names and numbers; target ≤120 characters, 160 at most.** Cap lists with the `, +N more` convention — `formatGaps()` in `src/core/gaps.ts` for number runs, the `listNames` helpers for files.

**Summarize checks that fire wholesale.** When a problem usually affects a whole season or album at once, emit one warning for the season or album folder with counts and a few samples, not one per file — see `warn_missing_episode_title`, `warn_episode_code_case`, and shows `warn_quality_mismatch` (one row per episode once produced 7,346 rows on a single drive).

**If your check's `path` is a display label rather than a real category-anchored library path, pass `options.scope`.** `deriveScope` reads a warning's level chain off its path, which is right for 84 of the ~91 call sites; the rest — the four duplicate-copy checks, which span categories and so carry none, and the TMDB episode-name check, whose last segment is an `S03E01` code where a filename would sit — would be read at the wrong level and become unsilenceable. Spelling out `{categories, levels}` is also what lets a `folders:` entry reach a check that spans categories.

## Useful commands

```bash
npm run all           # scan:all → validate:all → plex:pull → plex:check → report (skips what isn't set up)
npm run all external  # ...for the root named "External"
npm run all -- --no-report  # ...without the merged report step

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

npm run plex:pull                  # Plex libraries → output/plex/<library>/ (read-only GETs)
npm run plex:check                 # Compare the pull with scan output → output/<drive>/<type>/plex-warnings.json
npm run plex:logs                  # Download Plex's logs, tie errors to files → plex-log-warnings.json + output/plex/logs-summary.json
npm run plex:check -- --no-ignore  # Either Plex command without ignore lists → unfiltered/

npm run report                     # Fold every warnings file into all-warnings.json, one entry per folder
npm run report external
npm run report -- --type shows external

npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run lint:fix
npm run prettier:fix  # format .ts and .md in place
npm run check         # everything CI runs: typecheck, lint, test, prettier, lint:md
```

**Before calling work done:** run `npm run prettier:fix`, then `npm run check`. `check` runs the same steps, in the same order, as `.github/workflows/ci.yml`, so if it passes locally CI should too. If you change the CI workflow, keep `check` in step with it.

npm forwards bare positionals, so the drive name needs no `--` separator.

The smoke test pattern is to run the scan against the user's real library and confirm entry counts + warning counts don't regress. "Server" (`M:\`) is the full library, all categories; "External" (`D:\`) is a partial copy whose roots change over time — check `config.json` before smoke-testing it.

## Don't waste tokens

The user's library: ~2,500 movies, ~130 shows, ~220 music albums, ~110 audiobooks. With the probe cache primed (which it already is on this machine), all four scans finish in seconds. A FULL first-run probe over movies would be 12–20 min — but the cache should always be warm here. If you must invalidate the cache, do it deliberately. Cache files live at `cache/<drive>/<type>-probe.json`.

When making bulk changes across all 4 media types, use `Edit` with `replace_all: true` rather than reading each file separately. Most cross-cutting changes have an identical shape per file.

## Roadmap

There's no formal roadmap; `CHANGELOG.md` logs what has landed, and `package.json`'s version tracks its newest entry. The big-ticket items so far, all shipped:

- **Music quality summary** — per-album `audio_quality_summary` in `output/<drive>/music/data/probe.json` (`"FLAC 16/44.1"`, `"MP3 ~288"`). VBR tolerance collapses same-codec same-quality-target tracks into one entry.
- **ID3 tag reading for music** — per-track `tags` in `output/<drive>/music/data/probe.json` via `music-metadata`. Five warnings: compilation_detected, folder_tag_mismatch, folder_tag_case, missing_tags, track_number_mismatch.
- **TMDB validation for movies + shows** — `npm run validate:movies` / `validate:shows`. Cross-checks titles, years, and (for shows) per-season episode counts. API key in `.secrets.json` (gitignored). Cache in `cache/tmdb-*.json`.
- **Audiobook name checks + Open Library validation** — series/author consistency and embedded-tag comparison in the scan; `npm run validate:audiobooks` against Open Library (no key). Cache in `cache/openlibrary-search.json`.
- **Plex integration** — `plex:pull` (per-library catalogs + collections), `plex:check` (Plex vs disk), `plex:logs` (server log errors tied to files by item id). Read-only GET client in `src/plex/client.ts`; token in `.secrets.json`, URL in `config.json`. See `docs/PLEX.md`.

Future ideas: deeper music quality analysis (per-track bitrate distribution, encoding metadata), audiobook chapter/duration validation, custom user-defined checks via a DSL.

## Documentation layout

Each topic has exactly one home; everywhere else links to it rather than restating it. When the user asks something or you need to point them at existing docs, use this map:

- **README.md** — landing page only: pitch, requirements, quickstart, command table, links to the docs, project folders. No reference content.
- **CHANGELOG.md** — one entry per landed PR, newest first; bump `package.json`'s version to match.
- **docs/SCANS.md** — the workflow (first run, `npm run all`, what to re-run), scan and validate internals, and scan times
- **docs/CONFIG.md** — `config.json`, rules files and every setting, ignore lists (the canonical reference), `.secrets.json`
- **docs/CONVENTIONS.md** — Plex folder/file naming per media type, with gotchas; links to OUTPUT.md for warnings rather than listing them
- **docs/OUTPUT.md** — the output layout, file shapes, and the warning tables for the four media types
- **docs/PLEX.md** — Plex setup, path mapping, and the Plex commands with their warning tables
- **schemas/** — hand-maintained JSON Schemas for every output file; update the matching one when an output shape changes
- **ignored/\*.yaml.example** — short templates; a test uncomments them and runs them through the loader

When you add a new feature/warning/rule, update its home doc AND the matching warning table, then add a CHANGELOG entry.

## External references

- Plex naming: [Movies](https://support.plex.tv/articles/200381023-naming-movie-files/), [TV](https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/), [Music](https://support.plex.tv/articles/200265296-adding-music-media-from-folders/)
