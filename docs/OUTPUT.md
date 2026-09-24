# Output & Warning Reference

This page is the complete reference for what the scanner writes and every warning it can emit.

- For workflow guidance see [Scans](SCANS.md).
- For folder/file naming conventions see [Conventions](CONVENTIONS.md).
- For machine-readable shapes (JSON Schema Draft 2020-12) of every output file, see [`schemas/`](../schemas/) at the repo root.

---

## Output files

Every run writes its files under `output/<drive>/<type>/`, where `<drive>` is the lowercased `name` of the root you scanned (see [Configuration](CONFIG.md#configjson)).

The top of each folder holds only what you open — your catalog, the merged report, and one warnings file per command:

| File                       | Written by                           | What it is                                                                  |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `all-warnings.json`        | `npm run report`                     | **Open this first** — every command's warnings, one entry per folder        |
| `<type>.json`              | scan (`npm run <type>`)              | Your catalog — title, year, where each copy lives                           |
| `warnings.json`            | scan                                 | Every hygiene finding from the scan pass                                    |
| `validation-warnings.json` | validate (movies, shows, audiobooks) | Confidence warnings and title/year/author mismatches                        |
| `plex-warnings.json`       | `npm run plex:check`                 | Plex compared with the scan — see [Plex](PLEX.md#warnings)                  |
| `plex-log-warnings.json`   | `npm run plex:logs`                  | Errors from Plex's logs about files here — see [Plex](PLEX.md#log-warnings) |

The four per-command files are each one command's view. `all-warnings.json` folds them together so a show flagged by two commands is one entry instead of two files to join by hand — see [below](#all-warningsjson-the-merged-report).

Everything else sits in a subfolder:

| Folder        | Contents                                       | What it is                                                                                                                                                        |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/`       | `probe.json`, `validation.json`                | Detail behind the catalog: per-file inspection data (codec, bitrate, dimensions, embedded tags) and TMDB / Open Library match results. Other commands read these. |
| `fixes/`      | `rename-plan.json`, `rename-undo-<ts>.json`    | Shows only — the plan and undo manifests from [`npm run fix:shows`](SCANS.md#fixing-filenames--npm-run-fixshows). Keep the undo manifests.                        |
| `unfiltered/` | `plex-warnings.json`, `plex-log-warnings.json` | Only after a Plex command runs with `--no-ignore` — the same warnings with ignore lists skipped. See [Plex](PLEX.md#reviewing-what-your-ignore-lists-hide).       |

Files only appear once their command has run. Movies and shows validate against TMDB, audiobooks against Open Library; music has no validate pass. All four per-command warnings files share the `warnings.json` shape, and `all-warnings.json` is a superset of it.

If you used a version from before these subfolders existed, the old top-level `probe.json`, `validation.json`, `rename-plan.json`, and `*.unfiltered.json` files are no longer read — each command prints a note listing them. Delete them, but keep any `rename-undo-*.json` you might still need (`--undo` accepts any path).

Plex library pulls aren't tied to a drive, so they live apart, one folder per Plex library: `output/plex/libraries.json` plus `output/plex/<library>/catalog.json` and `collections.json`. Their shapes are described in [Plex](PLEX.md#npm-run-plexpull-library). `npm run plex:logs` adds `output/plex/logs-summary.json`, every distinct problem in the server's logs with counts — see [Plex](PLEX.md#logs-summaryjson).

Full layout, for a config with a `Server` root on every type and an `External` root on shows, after running every command:

```text
output/
├── plex/                         ← plex:pull and plex:logs (not tied to a drive)
├── server/
│   ├── movies/
│   │   ├── all-warnings.json
│   │   ├── movies.json
│   │   ├── warnings.json
│   │   ├── validation-warnings.json
│   │   ├── plex-warnings.json
│   │   ├── plex-log-warnings.json
│   │   └── data/
│   │       ├── probe.json
│   │       └── validation.json
│   ├── shows/
│   │   ├── all-warnings.json
│   │   ├── shows.json
│   │   ├── warnings.json
│   │   ├── validation-warnings.json
│   │   ├── plex-warnings.json
│   │   ├── plex-log-warnings.json
│   │   ├── data/
│   │   │   ├── probe.json
│   │   │   └── validation.json
│   │   └── fixes/
│   │       ├── rename-plan.json
│   │       └── rename-undo-<timestamp>.json
│   ├── music/
│   │   ├── all-warnings.json
│   │   ├── music.json
│   │   ├── warnings.json
│   │   ├── plex-warnings.json
│   │   ├── plex-log-warnings.json
│   │   └── data/
│   │       └── probe.json
│   └── audiobooks/
│       ├── all-warnings.json
│       ├── audiobooks.json
│       ├── warnings.json
│       ├── validation-warnings.json
│       ├── plex-warnings.json
│       ├── plex-log-warnings.json
│       └── data/
│           ├── probe.json
│           └── validation.json
└── external/
    └── shows/
        ├── all-warnings.json
        ├── shows.json
        ├── warnings.json
        └── data/
            └── probe.json
```

Each drive's files are self-contained — the scanner never merges catalogs across drives, and a title that exists on two drives simply appears in both. Nothing cross-references the other drive's output.

---

## Catalog shapes

Every catalog uses the same per-record `versions: [{category, quality}]` shape. Each version represents one physical copy of the media.

- `category` is the subfolder under `root_path` where the copy lives. If your library uses subfolders (e.g. `UHD/`, `HD/`, `Anime/`), the folder name appears here. If you don't use subfolders at all, every version's `category` will be `"default"`.
- `quality` is the bucket the file's actual content falls into. For movies and shows, it's derived from the video's dimensions via your `quality_thresholds` (UHD / HD / SD or `null` when no bucket matches). For music and audiobooks, it's the file codec (FLAC, MP3, M4B, etc.).

### `movies.json`

```json
[
  {
    "title": "Close Encounters of the Third Kind",
    "year": 1977,
    "edition": null,
    "versions": [{ "category": "UHD", "quality": "UHD" }]
  },
  {
    "title": "The Crow",
    "year": 1994,
    "edition": null,
    "versions": [
      { "category": "UHD", "quality": "UHD" },
      { "category": "HD", "quality": "HD" }
    ]
  }
]
```

### `shows.json`

```json
[
  {
    "title": "Star Trek Enterprise",
    "year": 2001,
    "edition": null,
    "seasons": [
      {
        "season": "1",
        "episode_count": 26,
        "versions": [{ "category": "HD", "quality": "HD" }],
        "episodes": [
          { "episode_start": 1, "episode_end": 2, "title": "Broken Bow Part 1 And 2" },
          { "episode_start": 3, "episode_end": 3, "title": "Fight or Flight" },
          { "episode_start": 4, "episode_end": 4, "title": null }
        ]
      },
      {
        "season": "Specials",
        "episode_count": 1,
        "versions": [{ "category": "HD", "quality": "HD" }],
        "episodes": [{ "episode_start": 1, "episode_end": 1, "title": "Behind the Scenes" }]
      }
    ]
  }
]
```

**Reading `edition`:** Plex's [TV Show Editions](CONVENTIONS.md#shows) tag, taken off the show folder (`Spider-Noir (2026) {edition-True Hue Color}`), or `null` when the folder carries none. Two editions of one series are two entries with the same title and year, each with its own seasons and episodes — Plex tracks them as separate items.

**Reading a season's versions:** if a season has the same `category` listed twice with different `quality` values, it means episodes inside that one folder don't all share the same quality. This is only meaningful if your library is organized by quality. Seasons where every episode has the same quality collapse to a single version.

**Reading a season's episodes:** one entry per episode file on disk. `episode_start === episode_end` is a single-episode file; `episode_start !== episode_end` is a multi-episode file (e.g. `S01E01-E02`). `title` is `null` when the filename omits the trailing `- Episode Title` portion — those fire `warn_missing_episode_title` (summarized once per season). The TMDB validate pass uses these to check titles against TMDB.

### `music.json`

```json
[
  {
    "artist": "Pink Floyd",
    "albums": [
      {
        "album": "The Wall",
        "track_count": 26,
        "versions": [{ "category": "Music", "quality": "FLAC" }]
      }
    ]
  }
]
```

### `audiobooks.json`

```json
[
  {
    "title": "Good Omens",
    "authors": ["Terry Pratchett", "Neil Gaiman"],
    "chapter_count": 26,
    "versions": [{ "category": "Audible", "quality": "M4B" }]
  }
]
```

### Catalog field notes for downstream consumers

A few things to know if you're building a website (or anything else) on top of these JSON files:

- **No `year` on music or audiobook catalogs.** Movies and shows have a `year` field; music and audiobooks don't. Album release years live in the embedded music tags and are exposed in `data/probe.json` under each track's `tags.year`; audiobooks have no defined year.
- **`"default"` is the category sentinel.** When your library uses no subfolders (empty `categories` config), every version's `category` will be the literal string `"default"`. You can group by category safely without special-casing flat libraries.
- **`authors` is always a string array.** Even single-author books come through as `["Single Author Name"]`, so consumers don't need to handle both shapes.
- **`title` can be `null` on `episodes[]`.** When an episode filename omits the trailing `- Episode Title`, the `title` field is `null` rather than an empty string. Same applies elsewhere — null means "intentionally absent," never `undefined` or missing key.
- **`quality` can be `null` on a `version`.** This means the file didn't fit any configured `quality_thresholds` bucket (movies/shows) or the file had no codec data (rare; usually a probe failure). Surface it as "unknown quality" in your UI.

### `warnings.json` (shape shared across scan + validate + Plex)

**Warnings are grouped by the folder they concern, not by warning type.** One show is one entry, however many checks fired on it — because that's the unit you work in. You sit down to fix Stranger Things, not to fix every `warn_quality_mismatch` in the library.

Each entry in `folders` carries:

| Field   | What it is                                                                     |
| ------- | ------------------------------------------------------------------------------ |
| `path`  | The folder, library-relative — `SD/Good Eats (1999)`. Every row hangs off this |
| `count` | How many rows are on it — grep this to find your worst offenders               |
| `rows`  | The warnings themselves                                                        |

`path` is the only locator you need. The **last segment is the folder's own name** —
`Good Eats (1999)` — which is what an ignore-list entry names; the segment before it is
the category. A `path` with no `/` is either a category folder, or the top-level name
itself in a library with no `categories`.

A row carries a `type`, an `issue` saying what's wrong, and a `path` **relative to the folder** — so it reads `Season 09`, not `SD/Good Eats (1999)/Season 09` for the fifth time. **A row with no `path` is about the folder itself.** `warn_non_primary` rows also carry an `extension`.

Above `folders`, `by_type` tallies how many rows each type produced, worst first — the same numbers the run prints. Both it and `folders` are sparse: only types and folders that actually fired appear.

`folders` is sorted alphabetically by `path`, and rows within a folder by their relative path, so the file diffs cleanly between runs. Season ordering is canonical, which means a scan's `Season 03` sorts next to the validate pass's `Season 3` rather than a screen apart — the two are about the same season.

```json
{
  "generated": "2026-04-20T10:30:00+00:00",
  "count": 12,
  "folder_count": 2,
  "by_type": {
    "warn_quality_mismatch": 8,
    "warn_missing_episode_title": 3,
    "warn_episode_gaps": 1
  },
  "folders": [
    {
      "path": "SD/Good Eats (1999)",
      "count": 3,
      "rows": [
        {
          "type": "warn_quality_mismatch",
          "path": "Season 09",
          "issue": "21/21 episodes are 1024x576 (fits HD) ×21, not SD (≤1000px). S09E01, S09E02, S09E03, +18 more."
        },
        {
          "type": "warn_episode_gaps",
          "path": "Specials",
          "issue": "Missing episodes (79): E09–E87."
        },
        {
          "type": "warn_missing_episode_title",
          "path": "Specials",
          "issue": "9/9 episode files have no \" - Episode Title\"."
        }
      ]
    },
    {
      "path": "UHD/The Terminator (1984)",
      "count": 1,
      "rows": [
        {
          "type": "warn_non_primary",
          "path": "The Terminator (1984).mkv",
          "issue": "Non-.MP4 video file.",
          "extension": ".mkv"
        }
      ]
    }
  ]
}
```

#### What's deliberately not in the file

**The remedy.** It's identical for every row of a warning type, so repeating it buried the facts that differ — it was once over 40% of the text in these files. Look the `type` up in the [warning tables](#warning-tables) below instead.

**Anything a field already says.** The folder's own name and its category are the last and first segments of `path`, and the distinct types on it are one pass over `rows`. All three were written out per folder until they were measured: they cost 13–18% of every warnings file, and the biggest one shrank from 116 KB to 96 KB without losing a single fact.

**Ignore-list entries.** Same reason as the remedy: every row of a type produced near-identical boilerplate. To silence something, take the last segment of the folder's `path` (or a row's relative `path` for something narrower) and put it under the matching level key in `ignored/<drive>/<type>.yaml`:

```yaml
# The whole show:
shows:
  - Firefly (2002)
# Just one season of it:
seasons:
  - Firefly (2002)/Season 01
```

An entry silences everything at or below its level, so `shows:` covers the whole folder and every row in it. Names YAML would misread — one starting with `'`, say — need quoting. See [Configuration](CONFIG.md#ignoreddrivetypeyaml--silencing-specific-warnings) for how matching works.

A row's `type` (a `warn_*` identifier) is the same string you use under `rules/<type>.yaml` `checks`, so it's copy-pasteable between the two. Ignore lists don't reference warning types at all — they list names by level — so `checks: false` is the only way to silence a whole warning _type_.

### `all-warnings.json` (the merged report)

`npm run report` folds all four warnings files above into one file per drive and media type, in the same folder-grouped shape. This is the file to open first: a show flagged by both the scan and the TMDB pass is **one entry** here rather than two files to join by hand.

Two additions to the shape above:

- Every row carries a `command` — `scan`, `validate`, `plex:check`, or `plex:logs` — and each folder lists the `commands` that flagged it, in pipeline order.
- A `sources` block at the top names every command that can contribute — all four, or three for music, which has no validate pass — with a `status` (`ok`, `stale`, `missing`, or `unreadable`), the source's own timestamp, and how many rows it contributed.

**Read `sources` first.** A command that has never run reports `"count": null`, not `0` — otherwise a report missing half its checks would look like a clean library. `stale` means that file is older than `warnings.json`, so it describes a library state that may have moved on; its rows are still folded in, and flagged. `unreadable` includes a file written before the folder regrouping — re-run that command.

```json
{
  "generated": "2026-04-20T11:00:00+00:00",
  "drive": "external",
  "media_type": "shows",
  "sources": [
    {
      "command": "scan",
      "file": "warnings.json",
      "status": "ok",
      "generated": "...",
      "count": 429
    },
    {
      "command": "plex:check",
      "file": "plex-warnings.json",
      "status": "missing",
      "generated": null,
      "count": null,
      "note": "Never run — `npm run plex:check external`. Nothing from this command is in this report."
    }
  ],
  "count": 532,
  "folder_count": 158,
  "by_type": { "warn_missing_episode_title": 228 },
  "folders": [
    {
      "path": "SD/The Great British Bake Off (2010)",
      "count": 30,
      "commands": ["scan", "validate"],
      "rows": [
        {
          "command": "scan",
          "type": "warn_missing_episode_title",
          "path": "Season 03",
          "issue": "10/10 episode files have no \" - Episode Title\"."
        },
        {
          "command": "validate",
          "type": "warn_tmdb_episode_count",
          "path": "Season 3",
          "issue": "10/14 episodes per TMDB — 4 missing."
        }
      ]
    }
  ]
}
```

Rows are **not** deduplicated. Two checks reporting the same season are two findings, both worth acting on — `warn_episode_gaps` tells you _which_ episodes are missing, `warn_tmdb_episode_count` tells you _how many_ TMDB expects. Canonical season ordering just puts them next to each other, as above.

The report reads only files under `output/` — never your media library — so it works with the drive unplugged. It reads the ignore-filtered files only, never the `unfiltered/` copies.

---

## Warning tables

Every warning has a per-type toggle in `rules/<type>.yaml` under `checks.warn_*`. Warnings ship enabled unless their table row says **Off by default**; set any toggle to `false` to silence that check everywhere. To silence specific items instead, list them by level in `ignored/<drive>/<type>.yaml` — see [Configuration](CONFIG.md#ignoreddrivetypeyaml--silencing-specific-warnings). The two are complementary: `checks` is per check, the ignore list is per item and silences every check on it.

The tables below list each warning by its `warn_*` identifier — a row's `type` in the warnings files and the toggle name under `checks` — alongside what triggered it and what to do about it. **These tables are where the remedy lives**; the files themselves carry only the facts that differ row to row. Warnings marked _(validate pass)_ only appear after `npm run validate:<type>`, in `validation-warnings.json`. The Plex warnings in `plex-warnings.json` and `plex-log-warnings.json` are listed in [Plex](PLEX.md#warnings).

### Movies

| Warning                                        | What it means                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn_non_primary`                             | The file exists but isn't your preferred format (set via `primary_extension`)                                                                                                                                                                                                                            |
| `warn_no_videos`                               | A movie folder has no video files (just sidecars or nothing at all)                                                                                                                                                                                                                                      |
| `warn_bad_file_name`                           | The file won't be picked up by Plex correctly                                                                                                                                                                                                                                                            |
| `warn_empty_edition`                           | The file has `{edition-}` with nothing after the dash                                                                                                                                                                                                                                                    |
| `warn_suspicious_year`                         | The year is before 1888 or in the future — likely a typo                                                                                                                                                                                                                                                 |
| `warn_title_mismatch`                          | The file name's title doesn't match its parent folder                                                                                                                                                                                                                                                    |
| `warn_title_case`                              | The file name's title matches its folder except for capitalization. Cosmetic, but Plex and your filesystem then present the same movie two ways                                                                                                                                                          |
| `warn_year_mismatch`                           | The file name's year doesn't match its parent folder                                                                                                                                                                                                                                                     |
| `warn_duplicate_edition`                       | Two files in the same folder claim the same `{edition-Name}`                                                                                                                                                                                                                                             |
| `warn_duplicate_quality`                       | The same movie is in two or more folders of the SAME quality tier (`HD/` + `Other HD/`) — redundant files. Not whitelistable                                                                                                                                                                             |
| `warn_multi_quality`                           | The same movie is in two quality folders (whitelist the combo via `acceptable_quality_combos`)                                                                                                                                                                                                           |
| `warn_loose_files`                             | Video files sitting directly in a category folder, not inside a `Movie Title (YEAR)/` folder — these are NOT added to the catalog                                                                                                                                                                        |
| `warn_extra_subfolders`                        | Subfolders found inside a `Movie Title (YEAR)/` folder — files inside them are NOT scanned                                                                                                                                                                                                               |
| `warn_unexpected_entries`                      | A non-video file that isn't a recognized Plex sidecar                                                                                                                                                                                                                                                    |
| `warn_quality_mismatch`                        | The file's actual dimensions don't fit the bucket its category implies                                                                                                                                                                                                                                   |
| `warn_short_duration`                          | The file's runtime is at or below `min_duration_minutes` — usually a truncated or failed encode. Expect legitimate hits on short films, TV specials and stand-up sets; list those under `movies:` in `ignored/<drive>/movies.yaml`. Off by default — `warn_tmdb_runtime_mismatch` is the precise version |
| `warn_tmdb_no_match` _(validate pass)_         | TMDB found nothing matching the title + year, under either the strict or loose comparison — a real typo, a missing diacritic, or an obscure film                                                                                                                                                         |
| `warn_tmdb_low_confidence` _(validate pass)_   | TMDB returned a match but the score was below the confidence threshold                                                                                                                                                                                                                                   |
| `warn_tmdb_year_mismatch` _(validate pass)_    | TMDB's release year disagrees with your folder year                                                                                                                                                                                                                                                      |
| `warn_tmdb_title_canonical` _(validate pass)_  | Your folder title differs byte-for-byte from TMDB's filename-safe canonical — a rename suggestion. Expected whenever a title matched via the loose tier (`Ghostbusters - Afterlife` → `Ghostbusters Afterlife`)                                                                                          |
| `warn_tmdb_runtime_mismatch` _(validate pass)_ | The file's runtime differs from TMDB's by more than `runtime_tolerance_percent`. Shorter means a truncated encode; longer means a wrong match, two features in one file, or an extended cut TMDB lacks                                                                                                   |
| `warn_probe_failed`                            | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml`                |

### Shows

| Warning                                             | What it means                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn_non_primary`                                  | The file exists but isn't your preferred format                                                                                                                                                                                                                                           |
| `warn_no_videos`                                    | A season folder has no video files                                                                                                                                                                                                                                                        |
| `warn_bad_show_folder`                              | Expected: `Show Title (YEAR)`, optionally `Show Title (YEAR) {edition-Name}`. A bracketed suffix like `[True Hue Color]` is not an edition to Plex and lands here                                                                                                                         |
| `warn_empty_edition`                                | The show folder has `{edition-}` with nothing after the dash. Catalogued as having no edition                                                                                                                                                                                             |
| `warn_bad_season_folder`                            | Expected: `Season 01`. Special-season names like `Specials` are whitelisted in `ignored_season_names`                                                                                                                                                                                     |
| `warn_bad_file_name`                                | Expected: `Show Title (YEAR) - S01E01 - Episode Title` (episode title optional)                                                                                                                                                                                                           |
| `warn_show_year_mismatch`                           | The episode file's show name or year doesn't match its parent show folder                                                                                                                                                                                                                 |
| `warn_show_title_case`                              | The episode file's show title matches its folder except for capitalization                                                                                                                                                                                                                |
| `warn_season_mismatch`                              | The episode file is in the wrong season folder. `fix:shows --fix season-code` rewrites the code to match the folder; move the file instead when the code is the right one                                                                                                                 |
| `warn_episode_gaps`                                 | A gap was detected in episode numbers within a season                                                                                                                                                                                                                                     |
| `warn_missing_episode_title`                        | Episodes in this season match Plex's naming convention but omit the trailing `- Episode Title` portion. Summarised once per season.                                                                                                                                                       |
| `warn_episode_code_case`                            | Episode codes in this season don't match the `episode_code_case` house style, or a multi-episode file uses the bare `-02` suffix instead of `-e02`. Summarised once per season; never fires when `episode_code_case` is `any`                                                             |
| `warn_loose_files`                                  | Episode files directly in a category folder or in a show folder (no `Season XX` wrapper) — NOT added to the catalog                                                                                                                                                                       |
| `warn_extra_subfolders`                             | Subfolders found inside a `Season XX/` folder — files inside them are NOT scanned                                                                                                                                                                                                         |
| `warn_unexpected_entries`                           | A non-video file that isn't a recognized Plex sidecar                                                                                                                                                                                                                                     |
| `warn_quality_mismatch`                             | Episodes in a season don't fit the bucket their category implies. Summarized once per season, with the resolutions found and the bucket each actually fits                                                                                                                                |
| `warn_duplicate_quality`                            | A single season is in two or more folders of the SAME quality tier (`HD/` + `Other HD/`) — redundant files. Not whitelistable                                                                                                                                                             |
| `warn_multi_quality`                                | A single season has copies in two quality folders (whitelist via `acceptable_quality_combos`)                                                                                                                                                                                             |
| `warn_tmdb_no_match` _(validate pass)_              | TMDB found nothing matching the title + year, under either the strict or loose comparison                                                                                                                                                                                                 |
| `warn_tmdb_low_confidence` _(validate pass)_        | TMDB match score below the confidence threshold                                                                                                                                                                                                                                           |
| `warn_tmdb_episode_count` _(validate pass)_         | Your local season has fewer episodes than TMDB lists                                                                                                                                                                                                                                      |
| `warn_tmdb_episode_name_mismatch` _(validate pass)_ | An episode's filename title doesn't match TMDB's title for that episode. Strict, filename-safe comparison.                                                                                                                                                                                |
| `warn_tmdb_title_canonical` _(validate pass)_       | Your folder title differs byte-for-byte from TMDB's filename-safe canonical — a rename suggestion. Expected whenever a title matched via the loose tier                                                                                                                                   |
| `warn_probe_failed`                                 | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml` |

### Music

| Warning                        | What it means                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn_non_primary`             | The file exists but isn't one of your preferred formats                                                                                                                                                                                                                                   |
| `warn_no_audio`                | An album folder has no audio files                                                                                                                                                                                                                                                        |
| `warn_bad_track_name`          | Expected: `01 - Track Name.ext` (single-disc) or `101 - Track Name.ext` (multi-disc)                                                                                                                                                                                                      |
| `warn_bad_artist_folder`       | The artist folder doesn't match `patterns.artist_folder` (default is permissive)                                                                                                                                                                                                          |
| `warn_bad_album_folder`        | The album folder doesn't match `patterns.album_folder` (default is permissive)                                                                                                                                                                                                            |
| `warn_suspicious_folder_chars` | Trailing whitespace, Windows-illegal characters, or a reserved name — these silently fragment Plex                                                                                                                                                                                        |
| `warn_track_gaps`              | A gap was detected in track numbers within an album (checked per-disc)                                                                                                                                                                                                                    |
| `warn_duplicate_album`         | The same artist + album appears in more than one category                                                                                                                                                                                                                                 |
| `warn_loose_files`             | Audio files in a category folder root or in an artist folder (no album wrapper) — NOT added to the catalog                                                                                                                                                                                |
| `warn_extra_subfolders`        | Subfolders found inside an album — files inside them are NOT scanned                                                                                                                                                                                                                      |
| `warn_unexpected_entries`      | A non-audio file that isn't a recognized sidecar                                                                                                                                                                                                                                          |
| `warn_quality_inconsistent`    | The album mixes codecs (FLAC + MP3) or has a wide bitrate spread (>64 kbps). Codec mixes can be whitelisted via `acceptable_codec_combos`.                                                                                                                                                |
| `warn_compilation_detected`    | The album has multiple distinct AlbumArtist values — likely belongs under `Various Artists/`                                                                                                                                                                                              |
| `warn_folder_tag_mismatch`     | The folder name disagrees with the embedded tag (artist or album)                                                                                                                                                                                                                         |
| `warn_folder_tag_case`         | The folder name matches its embedded tag except for capitalization (artist or album)                                                                                                                                                                                                      |
| `warn_missing_tags`            | Tracks are missing required embedded tags (title, album, or artist)                                                                                                                                                                                                                       |
| `warn_track_number_mismatch`   | The filename's track number disagrees with the embedded tag's track number                                                                                                                                                                                                                |
| `warn_mono_audio`              | The album contains tracks encoded as mono (single channel). Summarised once per album: "N of M tracks are mono". Most modern music should be stereo.                                                                                                                                      |
| `warn_probe_failed`            | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml` |

### Audiobooks

| Warning                                              | What it means                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn_non_primary`                                   | The file exists but isn't one of your preferred formats                                                                                                                                                                                                                                                                                                                      |
| `warn_no_audio`                                      | A book folder has no audio files                                                                                                                                                                                                                                                                                                                                             |
| `warn_bad_chapter_name`                              | Expected: `01 - Chapter Name.ext` (single-disc) or `101 - Chapter Name.ext` (multi-disc)                                                                                                                                                                                                                                                                                     |
| `warn_chapter_gaps`                                  | A gap was detected in chapter numbers within a book (checked per-disc)                                                                                                                                                                                                                                                                                                       |
| `warn_duplicate_book`                                | The same book title appears in more than one category                                                                                                                                                                                                                                                                                                                        |
| `warn_loose_files`                                   | Audio files in a category folder root or in an author folder (no book wrapper) — NOT added to the catalog                                                                                                                                                                                                                                                                    |
| `warn_extra_subfolders`                              | Subfolders found inside a book — files inside them are NOT scanned                                                                                                                                                                                                                                                                                                           |
| `warn_unexpected_entries`                            | A non-audio file that isn't a recognized sidecar                                                                                                                                                                                                                                                                                                                             |
| `warn_series_name_mismatch`                          | The same series is spelled differently across books (`Gaunt's Ghost, Book 1` vs `Gaunt's Ghosts, Book 2`) — a plural slip, a typo one character off, or punctuation drift. The spelling most books use is recommended as the rename                                                                                                                                          |
| `warn_series_name_case`                              | A series name or title prefix differs only in capitalization across books (`HALO - Legacy of Onyx` vs `Halo - The Flood`)                                                                                                                                                                                                                                                    |
| `warn_author_name_mismatch`                          | The same author is written two ways (`Tobias S. Buckell` vs `Tobias Buckell`, `J.R.R.` vs `J. R. R.`), including inside multi-author folders. Plex treats them as separate people                                                                                                                                                                                            |
| `warn_author_name_case`                              | An author name differs only in capitalization across books                                                                                                                                                                                                                                                                                                                   |
| `warn_encoded_characters`                            | A book or author folder contains HTML entities (`&quot;`, `&amp;`) instead of the actual characters — usually left by a download tool                                                                                                                                                                                                                                        |
| `warn_mixed_punctuation`                             | A folder name uses curly quotes where most of the library uses straight ones (or the reverse). Full-width stand-ins for filename-illegal characters (`？`, `꞉`) are not flagged                                                                                                                                                                                              |
| `warn_book_tag_mismatch`                             | The album tag names a different book than the folder. Audible conventions are normalized first — `(Unabridged)`, a colon where the folder has a dash, and a folder that adds a subtitle or series all still match                                                                                                                                                            |
| `warn_book_tag_case`                                 | The album tag matches the folder except for capitalization (Audible tags often use `HALO:` where folders use `Halo -`)                                                                                                                                                                                                                                                       |
| `warn_author_tag_mismatch`                           | The artist tag names different authors than the author folder. Order and role suffixes (`Danusia Stok - translator`) are ignored; different initials or spacing still count, and the message says so                                                                                                                                                                         |
| `warn_author_tag_case`                               | The artist tag matches the author folder except for capitalization                                                                                                                                                                                                                                                                                                           |
| `warn_missing_book_tags`                             | No chapter in the book carries an album or artist tag                                                                                                                                                                                                                                                                                                                        |
| `warn_openlibrary_title_mismatch` _(validate pass)_  | No Open Library title matches, but a book by the same author is a typo's distance away. Verify the spelling; the message gives Open Library's title                                                                                                                                                                                                                          |
| `warn_openlibrary_title_case` _(validate pass)_      | Open Library's title differs only in capitalization. **Off by default** — Open Library capitalizes inconsistently itself                                                                                                                                                                                                                                                     |
| `warn_openlibrary_author_mismatch` _(validate pass)_ | The title matches an Open Library book, but none of the folder's authors do. **Off by default** — `warn_author_name_mismatch` and `warn_author_tag_mismatch` already compare the author folder against its siblings and its tags, so a typo produced three findings for one rename. Those two need no network, and Open Library credits narrators and translators as authors |
| `warn_openlibrary_not_found` _(validate pass)_       | Nothing in Open Library resembles the title. **Off by default** — coverage of tie-in fiction is patchy, and translated books are often listed only under their original title                                                                                                                                                                                                |
| `warn_probe_failed`                                  | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml`                                                                                    |
