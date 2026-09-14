# Changelog

What's landed, newest first. Not formal release notes — pointers to what's new if you're returning after time away. Entries marked _(breaking)_ change a file format or setting you may need to update.

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
