# Changelog

What's landed, newest first. Not formal release notes — pointers to what's new if you're returning after time away. Entries marked _(breaking)_ change a file format or setting you may need to update.

## v0.17

- _(breaking)_ Shows support Plex's [TV Show Editions](docs/CONVENTIONS.md#shows). A show folder may carry a `{edition-Name}` tag after the year (`Spider-Noir (2026) {edition-True Hue Color}`), and each edition is its own catalog entry with its own seasons — matching how Plex tracks them as separate items with separate watch state. `shows.json` and shows `validation.json` gained an `edition` field; `output/<drive>/shows/data/probe.json` did too. Two editions of one season are no longer reported as duplicate copies of each other.
- `warn_empty_edition` (shows) flags a folder tagged `{edition-}` with no name after the dash. A bracketed suffix such as `[True Hue Color]` is deliberately still `warn_bad_show_folder` — Plex does not read it as an edition.
- `fix:shows --fix show-prefix` rebuilds each file's prefix from its folder's parsed title and year rather than the folder name, so an edition tag stays on the folder and off the episode files.
- `plex:pull` records each item's `edition_title`, and `plex:check` gained `warn_plex_edition_mismatch` and `warn_plex_edition_case` comparing it with the folder's tag. Shows only for now: a movie's edition tag is in its filename, so its folder has nothing to compare against.

## v0.16

- _(breaking)_ Warnings files are much shorter. Each `by_type` bucket is now `{ fix, items }`: the recommended fix is written once for the bucket instead of on every row, and each item's `issue` states only what is wrong there. Median issue length went from 264 characters to about 120 — see [`warnings.json`](docs/OUTPUT.md#warningsjson-shape-shared-across-scan--validate).
- Every warning message was rewritten to lead with names and numbers. Missing episodes, tracks and chapters collapse into ranges (`E02–E20, E22`) and stop after eight, instead of listing every one — a single row once reached 3,600 characters.
- `plex-log-warnings.json` rows name up to three problems and drop the per-folder advice and sample log line. The advice is in the [log problem table](docs/PLEX.md#log-warnings), now keyed by the name the warning uses, and the samples are in `logs-summary.json`.
- The warning tables in [Output](docs/OUTPUT.md#warning-tables) are keyed by `warn_*` identifier, matching the Plex tables.
- `fix:shows --fix episode-titles --allow-partial` names seasons you hold only part of. Each entry is marked for review in the dry run — see [the season guard](docs/SCANS.md#the-season-guard-on-episode-titles).
- `warn_tmdb_episode_name_mismatch` no longer flags titles that are correct once an illegal character and a trailing period are both dropped (`Chevy Chase/Sheila E.` → `Chevy ChaseSheila E`, `7:00 A.M.` → `700 A.M`).

## v0.15

- `fix:shows --fix show-folder` renames one show folder you name with `--show` and `--to`, for when the folder rather than its files is wrong. The dry run shows the TMDB title and the files' prefix as hints — see [Fixing filenames](docs/SCANS.md#fixing-filenames--npm-run-fixshows).
- Show episode files with 3-digit episode numbers (`S00E201`) are now valid instead of `warn_bad_file_name`.
- `fix:shows --fix episode-code` also zero-pads unpadded numbers (`s02e4` → `s02e04`), and `warn_bad_file_name` points at it for those files.

## v0.14

- Every warning row carries an `ignore` field with the narrowest ready-to-paste ignore-list entry that silences it — see [Silencing a row](docs/OUTPUT.md#silencing-a-row).
- A missing `root_path` (disconnected drive, moved folder) now stops the scan and `plex:check` instead of scanning an empty library — which had overwritten output and emptied the probe cache. Cache entries under a category folder that is missing for one run are kept too.
- `fix:shows --undo` validates the whole manifest first and refuses any rename that would move a file between folders or overwrite one.
- Warm scans on network shares are faster: orphan pruning no longer re-checks files the scan just found.
- Missing category folders are reported once per scan instead of twice.
- Shows `warn_quality_mismatch` is summarized once per season — with the resolutions found and the bucket each actually fits — instead of one row per episode.
- Dependencies: ESLint 10 (flat config), Vitest 5, `@types/node` 22, and minor updates. Node 22.12 or newer is now required.

## v0.13

- Docs consolidated: the README is now a short landing page, and each topic has one home in [`docs/`](docs/) — output layout in [Output](docs/OUTPUT.md), ignore lists in [Configuration](docs/CONFIG.md), the workflow and scan times in [Scans](docs/SCANS.md). This changelog moved out of the README.
- The `ignored/*.yaml.example` files are short templates that link to the reference instead of repeating it.
- `package.json` version now tracks this changelog.

## v0.12

- `npm run all [drive]` runs scan → validate → Plex pull → Plex check in one go, skipping steps that aren't set up.
- Media types in `config.json` are optional — leave out any you don't have.
- Per-root `probe_concurrency` speeds up first scans on SSDs and network shares.
- Cache and output files are written atomically, so an interrupted run can't corrupt the probe cache.
- `validate:all` skips movies and shows instead of failing when there's no TMDB key. TMDB requests time out after 30 s and stop retrying after repeated rate limits.

## v0.11

- Tidier output folders: the top of `output/<drive>/<type>/` holds only the catalog and the warnings files. `probe.json` and `validation.json` moved to `data/`, `fix:shows` plans and undo manifests to `fixes/`, and `--no-ignore` output to `unfiltered/`. Commands point out old top-level files that can be deleted.
- `cache/tmdb-show-seasons.json` keeps only episode numbers, titles and air dates (~90 MB → ~2 MB); existing caches shrink on the next `validate:shows`.
- `config.json` is gitignored — copy `config.example.json`.

## v0.10

- `npm run plex:logs` downloads the server's logs and ties Plex's errors to library files by item id (`warn_plex_log_error`; `warn_plex_log_warning`, off by default), with a server-wide `output/plex/logs-summary.json`.
- `--no-ignore` on both Plex commands writes an unfiltered copy to review what ignore lists hide.
- The Plex title check ignores bare year suffixes (`Space King 2024`), and collection pulls stay under Plex's 120-item page limit.
- JSON Schemas for every Plex output under [`schemas/`](schemas/).

## v0.9

- Plex integration: `npm run plex:pull` writes each library's catalog and collections under `output/plex/<library>/`; `npm run plex:check` compares them with the scan (missing, orphaned, trashed, unmatched, wrongly matched, and duplicate items, plus folders no library covers). Read-only GET client; token in `.secrets.json`, server address in `config.json`. See [Plex](docs/PLEX.md).

## v0.8

- Audiobook name checks: series and author spelling drift, capitalization, HTML entities, and mixed punctuation across books; embedded tags compared with folders.
- `npm run validate:audiobooks` cross-checks titles and authors against Open Library (no API key).
- `.secrets.json` blocks became per-integration.

## v0.7 _(breaking)_

- Ignore lists are keyed by level with bare names (`shows: Firefly (2002)`) instead of a flat list of path prefixes. Names are matched at their level and are category-independent, which makes the cross-category checks (`warn_multi_quality`, `warn_duplicate_quality`, `warn_duplicate_album`, `warn_duplicate_book`) silenceable.
- For shows, `Season 3` ≡ `Season 03` and an episode's filename ≡ its `S03E01` code, so one entry covers the scan, probe and validate passes.
- Per-entry `types:` scoping is gone; use `checks.warn_*: false` to silence a whole warning type. Old-format files fail fast with a migration message.

## v0.6

- `warnings.json` and `validation-warnings.json` switched to a `by_type` map (sparse, alphabetized) instead of a flat `files` array.
- Run output prints a per-type breakdown after the totals line.
- JSON Schema files for every output under [`schemas/`](schemas/).

## v0.5

- `acceptable_album_combos` (music) and `acceptable_book_combos` (audiobooks) whitelist intentional cross-category duplicates.
- `warn_mono_audio` (music, per-album summary).
- TMDB cache TTL with the opt-in `--refresh-older-than=Nd` flag.
- Probe cache orphan cleanup at the end of each scan. Rules load lazily — `npm run movies` only loads the movies rules.

## v0.4

- Type-scoped ignore-list entries (`{path, types: [...]}`) — later removed in v0.7.
- TMDB episode-name validation (`warn_tmdb_episode_name_mismatch`, opt-in for multi-episode files via a separate toggle).
- `warn_missing_episode_title` (per-season summary).
- Music probe paths include the category prefix. Audiobook duplicate-book paths use `Author/Book Title`, matching music.

## v0.3

- Every warning carries a stable `type` identifier matching its `warn_*` toggle.
- Validation-warning paths gained a category prefix when the library is organized by subfolder.
- All warning paths use forward slashes on every OS.
