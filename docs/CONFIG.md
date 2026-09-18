# Configuration & Rules

Everything you can configure, in four files:

| File                                                                                | What it holds                                                                                          | You edit it…                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [`config.json`](#configjson)                                                        | Where your library lives: named roots per media type, plus the Plex server address                     | Always — once, at setup                     |
| [`rules/<type>.yaml`](#rules-typeyaml-and-typelocalyaml)                            | How your library is organized: categories, extensions, name patterns, quality buckets, warning toggles | When your library differs from the defaults |
| [`ignored/<drive>/<type>.yaml`](#ignoreddrivetypeyaml--silencing-specific-warnings) | Specific items whose warnings you've decided to live with                                              | As you review warnings                      |
| [`.secrets.json`](#secretsjson)                                                     | TMDB API key and Plex token                                                                            | Only if you use those features              |

---

## `config.json`

`config.json` is gitignored, since it holds your own paths. Start by copying the committed template:

```bash
cp config.example.json config.json
```

One section per media type. Each section is a **list of named roots**, so a media type can span several drives:

```json
{
  "movies": [
    { "root_path": "M:\\Movies", "name": "Server" },
    { "root_path": "D:\\Movies", "name": "External" }
  ],
  "shows": [
    { "root_path": "M:\\Shows", "name": "Server" },
    { "root_path": "D:\\Shows", "name": "External" }
  ],
  "music": [{ "root_path": "M:\\Audio", "name": "Server" }],
  "audiobooks": [{ "root_path": "M:\\Audiobooks", "name": "Server" }]
}
```

**`root_path`** — absolute path to that root's library folder. Platform notes:

- **Windows:** `"Z:\\Movies"` (double backslashes inside JSON)
- **macOS:** `"/Volumes/Movies"`
- **Linux:** `"/mnt/nas/Movies"`

**`name`** — what you call that drive. It's yours to pick (`Server`, `External`, `NAS`, `Archive`), with three constraints:

- Letters, numbers, dots, dashes, and underscores only — it becomes a folder name. `.` and `..` on their own are rejected.
- Unique within a media type (case-insensitively).
- The same name can be reused across media types. `Server` holding both movies and music is the normal case.

`plex` is reserved — `output/plex/` holds Plex library pulls, so no drive can use that name.

**`probe_concurrency`** _(optional)_ — how many files the scan inspects at once on that root, from 1 to 16. The default, 1, is right for spinning disks, where parallel reads fight over the drive head. SSDs and network shares usually get through a first scan several times faster at 4–8. It only matters for files that aren't in the probe cache yet, so re-scans are fast either way. Set it per root, because drives differ:

```json
"movies": [
  { "root_path": "M:\\Movies", "name": "Server", "probe_concurrency": 6 },
  { "root_path": "D:\\Movies", "name": "External" }
]
```

An optional **`plex`** block holds your Plex server address (`url`) and, when needed, `path_map` entries translating Plex's paths to yours. See [Plex](PLEX.md#setup). The Plex token goes in [`.secrets.json`](#secretsjson), not here.

**Leave out any media type you don't have** — a config with only `music` is fine, as long as at least one type is listed. `scan:all` and the other `--all` commands skip unconfigured types; running one directly (`npm run shows`) explains how to add it.

The scanner walks the subfolders defined in the rules files under `categories`, or — if `categories` is empty in the rules file — it walks `root_path` directly and labels every record's category as `"default"`. Categories are defined per _type_, not per drive, so the same `rules/<type>.yaml` applies to every root. A category folder missing from one drive is just skipped.

### Selecting a drive

A run always targets exactly one root. Name it positionally, or omit it to get the **first root in the list**:

```bash
npm run movies              # first movies root — "Server"
npm run movies external     # the root named "External" (case-insensitive)
npm run validate:movies external
npm run scan:all external   # every type that has an "External" root
```

Naming a drive that isn't configured for a type — or running a type that isn't in `config.json` at all — is an error on a single-type command. The `--all` commands (`scan:all`, `validate:all`, `plex:check`, `npm run all`) skip that type with a note instead. That's what lets `npm run scan:all external` work when only movies and shows live on the external drive.

If a root's `root_path` doesn't exist — the drive is disconnected, or the folder moved — the scan and `plex:check` stop for that root instead of treating it as an empty library, so nothing is overwritten and the probe cache isn't pruned. Update `root_path` if the folder moved.

### Per-drive files

The root's name (lowercased) becomes a folder segment, so drives never share state:

```text
output/server/movies/                 output/external/movies/
cache/server/movies-probe.json        cache/external/movies-probe.json
ignored/server/movies.yaml            ignored/external/movies.yaml
```

Keeping the probe cache separate matters: cache entries are keyed by a path _relative_ to the root, so a shared cache file would let one drive's orphan cleanup delete the other drive's entries.

The TMDB caches (`cache/tmdb-*.json`) are deliberately **not** split per drive — they're keyed by title and year, not by path, so every drive reuses the same lookups.

That's it for `config.json`. Everything else lives in `rules/<type>.yaml`.

---

## Rules: `<type>.yaml` and `<type>.local.yaml`

Each media type has up to two files in the `rules` folder, and `plex.yaml` covers the Plex checks:

```text
rules/
├── movies.yaml             ← default configuration
├── movies.local.yaml       ← personal overrides (optional, gitignored)
├── shows.yaml
├── music.yaml
├── audiobooks.yaml
└── plex.yaml               ← warning toggles for plex:check and plex:logs — see Plex
```

Rules are per media type, not per drive — the same `rules/movies.yaml` applies to every movies root.

**`rules/<type>.yaml`** ships with every option set to the code default — fully visible, no comment-block tricks. Edit a value to change the project-wide default for this checkout. Comment a line out to fall back to whatever the current code default is (useful when you want to "ignore" a setting and let the code decide).

**`rules/<type>.local.yaml`** is for personal library-specific overrides — your folder structure, your quality buckets, anything that wouldn't apply to a generic Plex library. This file is gitignored so it never gets committed.

### How the loader merges them

Top to bottom, each layer wins over the one above:

```text
code defaults  →  rules/<type>.yaml  →  rules/<type>.local.yaml  →  Zod-validated result
```

Note: Zod is a configuration validator that catches typos and bad values in your rules files before the scanner runs — so a misnamed key or wrong type fails at startup with a clear message instead of crashing partway through a scan.

Boot-time logs make it clear which files contributed:

```text
[RULES] Loaded rules/movies.yaml + 3 override(s) from rules/movies.local.yaml
[RULES] Loaded rules/shows.yaml (no local overrides)
[RULES] Using code defaults (no rules/audiobooks.yaml found)
```

---

## Three configuration shapes

Before diving into individual settings, here are the three common ways people organize categories. Knowing which shape fits your library makes the settings reference below much easier to navigate.

### A. Quality-organized categories (e.g. movies + shows by UHD/HD/SD)

You have subfolders like `UHD/`, `HD/`, `SD/`, possibly with `Other UHD/`, `Other HD/`, `Other SD/` variants. You want the scanner to:

- Flag files whose actual dimensions don't match the quality their folder implies (`warn_quality_mismatch`)
- Flag the same media stored across multiple distinct qualities (`warn_multi_quality`)
- Flag the same media stored twice at the SAME quality, e.g. in both `HD/` and `Other HD/` (`warn_duplicate_quality`)

**Configure**:

```yaml
# rules/movies.local.yaml
categories:
  - { name: UHD }
  - { name: HD }
  - { name: SD }
  - { name: Other UHD } # quality auto-detected as UHD
  - { name: Other HD } # quality auto-detected as HD
  - { name: Other SD } # quality auto-detected as SD

quality_thresholds:
  - { name: UHD, min_width: 2000 }
  - { name: HD, min_width: 1000, max_width: 2000 }
  - { name: SD, max_width: 1000 }

acceptable_quality_combos:
  - [UHD, HD] # auto-detect collapses "Other UHD"+"Other HD" into the same set
```

**Quality auto-detection rule**: each category name is scanned for the whole-word, case-insensitive substring `UHD`, `HD`, or `SD` (UHD checked first so it wins over the contained `HD`). Matching is on word boundaries — `USD`, `Standard`, or `Hi-Def` do NOT match.

### B. General-purpose tag categories (e.g. audiobooks: Audible, Book On CD)

Your subfolder names are concepts (a format, an imprint, a vendor) that aren't quality buckets. You want each record tagged with which folder it's in, but no dimension checks should apply.

**Configure**:

```yaml
# rules/audiobooks.local.yaml
categories:
  - { name: Audible }
  - { name: Other Audible }
  - { name: Book On CD }
# quality_thresholds and acceptable_quality_combos are not used in this scenario
```

Because none of these names contain `UHD`/`HD`/`SD`, all categories resolve to `quality: null`. `warn_quality_mismatch` never fires. `warn_duplicate_book` still fires if the same book exists across multiple categories.

### C. No categories — flat library

Your media just lives directly under `root_path` with no subfolders for organization.

**Configure**:

```yaml
categories: [] # or omit entirely
```

The scanner walks `root_path` directly and labels every record's category as `"default"`. No quality or duplicate checks fire. Naming hygiene checks still work.

---

## Settings reference

Each setting lives in `rules/<type>.yaml`. For each one below: what it is, why you'd change it, which warnings it controls, and a typical override.

### `patterns`

**Applies to:** all four types.

**What it is:** Regular expressions with named capture groups that tell the scanner how to parse your folder and file names. Each pattern can be a plain string or `{ pattern, flags }` if you need flags like case-insensitive matching.

**Why you'd change it:** Your library uses a different naming convention than Plex's defaults. Most users won't touch this.

**Related warnings:** anything that flags a name that doesn't match the expected format — `warn_bad_file_name`, `warn_bad_folder_name`, `warn_bad_show_folder`, `warn_bad_season_folder`, `warn_bad_artist_folder`, `warn_bad_album_folder`, `warn_bad_chapter_name`.

**Example:**

```yaml
patterns:
  folder: '^(?<title>.+)\s\((?<year>\d{4})\)$' # The Crow (1994)
  file: '^(?<title>.+)\s\((?<year>\d{4})\)$' # The Crow (1994).mp4
```

**The `edition` group.** Two patterns carry an optional `edition` capture group for Plex's `{edition-Name}` tag — `movies.patterns.file` and `shows.patterns.show_folder`. The level differs because Plex's does: a movie edition is a file in a shared folder, a show edition is a whole folder. Dropping the group from either pattern makes tagged names unparseable, so they fire `warn_bad_file_name` / `warn_bad_show_folder` instead. See [CONVENTIONS.md](CONVENTIONS.md) for the naming rules and `warn_empty_edition` for a tag with no name.

---

### `categories`

**Applies to:** all four types.

**What it is:** A list of subfolder names under `root_path` that the scanner walks. Each category's `name` is both the folder name on disk AND the label that appears on each catalog entry.

**Why you'd change it:** To tell the scanner which subfolders to look in and how to organize the output. See [Three configuration shapes](#three-configuration-shapes) above to pick the right shape for your library.

**Related warnings:** `warn_quality_mismatch`, `warn_multi_quality`, `warn_duplicate_quality`, `warn_duplicate_album`, `warn_duplicate_book` all depend on how you set this up.

**Example:**

```yaml
categories:
  - { name: UHD }
  - { name: HD }
  - { name: Other UHD }
```

---

### `primary_extension`

**Applies to:** all four types.

**What it is:** The file format(s) you consider canonical for this media type. Movies might be `.mp4`; music might be `.flac`.

**Why you'd change it:** You've standardized on a different format and want to spot stragglers that don't match.

**Related warnings:** `warn_non_primary` — fires when a file uses a different extension from the primary list. Useful for finding files you may want to re-encode.

**Example:**

```yaml
primary_extension:
  - .mp4
```

---

### `video_extensions` / `audio_extensions`

**Applies to:** `video_extensions` on movies + shows; `audio_extensions` on music + audiobooks.

**What it is:** Every file extension the scanner recognizes as media for this type. Anything outside this list AND outside `sidecar_extensions` is flagged as unexpected.

**Why you'd change it:** Your library uses a format the defaults don't include (e.g. `.webm`, `.ogg`).

**Related warnings:** `warn_unexpected_entries` — fires when a file isn't media, isn't a sidecar, and isn't a known OS artifact like `Thumbs.db`.

**Example:**

```yaml
video_extensions:
  - .mp4
  - .mkv
  - .avi
  - .webm
```

---

### `sidecar_extensions`

**Applies to:** all four types.

**What it is:** Non-media file extensions that are OK to find alongside your media — Plex sidecar files like `.nfo` metadata, `.srt` subtitles, `.jpg` poster art, lyrics, PDF booklets, etc.

**Why you'd change it:** You have a sidecar type the defaults don't include and you're tired of seeing it flagged as unexpected.

**Related warnings:** `warn_unexpected_entries` — adding an extension here removes those files from the unexpected-entries flag.

**Example:**

```yaml
sidecar_extensions:
  - .nfo
  - .srt
  - .jpg
```

---

### `year_range`

**Applies to:** movies only.

**What it is:** The minimum and maximum years a movie's release can plausibly be. `max: current` resolves to the current calendar year so you don't have to bump it every January.

**Why you'd change it:** To relax or tighten the plausibility check (e.g. you have very early silent films from before 1888).

**Related warnings:** `warn_suspicious_year` — fires when a movie's year falls outside this range.

**Example:**

```yaml
year_range:
  min: 1888
  max: current
```

---

### `ignored_season_names`

**Applies to:** shows only.

**What it is:** Season folder names that bypass the `Season XX` regex check. Plex's standard `Specials` folder belongs here, plus any one-off named seasons your library uses (e.g. `Champion of Champions`).

**Why you'd change it:** Your library has named seasons that don't fit the numeric `Season XX` pattern and you don't want them flagged.

**Related warnings:** `warn_bad_season_folder` — bypassed for the folder names listed here.

**Example:**

```yaml
ignored_season_names:
  - Specials
  - Champion of Champions
```

---

### `episode_code_case`

**Applies to:** shows only.

**What it is:** The house style for the season/episode code in an episode filename — whether you write `s01e01` or `S01E01`. One of `lower`, `upper`, or `any` (the default).

Plex reads either form, and `patterns.file` is case-insensitive, so this is purely about your library reading consistently. `any` means "no house style" and never warns.

Whichever style you pick, the canonical multi-episode suffix spells the letter out — `s01e01-e02`, not the bare `s01e01-02`, which reads as a range of two different things depending on who's looking. The bare form is flagged under either `lower` or `upper`.

**Why you'd change it:** You care that every episode file in your library writes its code the same way.

**Related warnings:** `warn_episode_code_case`, summarised once per season.

**Fixing it:** `npm run fix:shows -- --fix episode-code <drive>` previews the renames; add `--apply` to execute. See [Scans](SCANS.md#fixing-filenames--npm-run-fixshows).

**Example:**

```yaml
episode_code_case: lower
```

---

### `quality_thresholds`

**Applies to:** movies + shows. **Only useful if your `categories` are organized by quality** (see [shape A above](#a-quality-organized-categories-eg-movies--shows-by-uhdhdsd)). If you're using general-purpose tag categories or a flat library, leave this empty.

**What it is:** Pixel-range buckets that define what `UHD`, `HD`, and `SD` mean dimensionally. Each bucket's `name` matches an auto-detected quality keyword from your category names (e.g. `Other UHD` resolves to quality `UHD` and gets checked against the `UHD` bucket). For each file, the scanner takes its long edge — the max of its width and height — and checks that it falls in the bucket's range.

**Why you'd change it:** Your library's idea of HD or UHD differs from the defaults, or you want to opt in to or out of the dimension check entirely.

**Related warnings:** `warn_quality_mismatch` — fires when a file's actual dimensions don't fit the bucket its category's auto-detected quality implies.

**Example:**

```yaml
quality_thresholds:
  - { name: UHD, min_width: 2000 }
  - { name: HD, min_width: 1000, max_width: 2000 }
  - { name: SD, max_width: 1000 }
```

---

### `min_duration_minutes`

**Applies to:** movies only.

**What it is:** A runtime floor in minutes. Any movie file whose ffprobe duration is at or below it gets flagged. The target is a truncated or failed encode — a 4-minute file where a 2-hour film should be. Set to `0` to disable the check entirely.

**Why you'd change it:** Lower it if you keep a lot of legitimate short content and only care about catastrophic truncation; raise it if your library is all feature films.

**Related warnings:** `warn_short_duration`, which is **off by default** — turn it on with `checks.warn_short_duration: true`. [`runtime_tolerance_percent`](#runtime_tolerance_percent) is the precise version of this check.

**Expect legitimate hits.** Short films, animated TV specials, and stand-up sets are genuinely under 30 minutes, so this is a review list rather than an error list. List the ones you've checked under `movies:` in `ignored/<drive>/movies.yaml` (this silences that movie's other warnings too):

```yaml
movies:
  - Luxo Jr. (1986)
```

**Example:**

```yaml
min_duration_minutes: 30
```

---

### `runtime_tolerance_percent`

**Applies to:** movies only. **Runs in the validate pass**, so it needs a TMDB match to compare against.

**What it is:** How far a file's measured runtime may drift from TMDB's before it's flagged, as a percentage of TMDB's runtime. Symmetric — `50` flags anything under half or over one-and-a-half times TMDB's figure. Set to `0` to disable.

**Why you'd change it:** Lower it to catch subtler drift (a missing reel, a cut-short recording); raise it if you keep a lot of extended cuts TMDB doesn't carry.

**Related warnings:** `warn_tmdb_runtime_mismatch`.

This is the precise counterpart to [`min_duration_minutes`](#min_duration_minutes). A genuine 2-minute short matches TMDB's 2-minute runtime and stays silent, while a feature truncated to 5 minutes is caught regardless of how long it is. The over-length side catches a class of error that title + year scoring cannot see at all: a short film sharing a feature's exact title and year scores `high` confidence, and only the runtime gives it away.

**Example:**

```yaml
runtime_tolerance_percent: 50
```

---

### `acceptable_quality_combos`

**Applies to:** movies + shows. **Only useful if your `categories` are organized by quality** (see [shape A above](#a-quality-organized-categories-eg-movies--shows-by-uhdhdsd)). If you don't use quality categories, this setting does nothing.

**What it is:** A list of quality sets that are explicitly OK to coexist for a single item. After category-to-quality mapping, a movie that lives in both `Other UHD` and `Other HD` resolves to the quality set `{UHD, HD}` — listing `[UHD, HD]` here tells the scanner that's an intentional pair, not a hygiene problem. For shows, the same logic applies per-season (different seasons in different qualities are fine on their own).

**Why you'd change it:** You intentionally keep multiple-quality copies of some items (e.g. a 4K master and a 1080p downscale for travel devices).

**Related warnings:** `warn_multi_quality` — silenced when an item's quality set matches a combo listed here.

**What it does NOT silence:** `warn_duplicate_quality`. A combo lists which quality _tiers_ may coexist; it says nothing about how many copies may sit inside one tier. A movie in `UHD/` + `HD/` + `Other HD/` still resolves to the tier set `{UHD, HD}` and matches `[UHD, HD]`, so `warn_multi_quality` stays quiet — but the two HD-tier copies are reported as duplicates regardless. If you genuinely want those, silence them per-path in `ignored/<drive>/<type>.yaml` or turn the check off entirely.

**Example:**

```yaml
acceptable_quality_combos:
  - [UHD, HD]
```

---

### `acceptable_codec_combos`

**Applies to:** music only.

**What it is:** A list of codec sets that are explicitly OK to coexist within a single album. After deriving each track's codec, an album that mixes FLAC and MP3 resolves to the codec set `{FLAC, MP3}` — listing `[FLAC, MP3]` here tells the scanner that's intentional, not a hygiene problem. Only applies to codec MIX cases. Bitrate-spread within a single codec (e.g. `MP3 192` mixed with `MP3 320`) still fires `warn_quality_inconsistent` even when `[MP3]` is whitelisted on its own.

**Why you'd change it:** You intentionally keep mixed-codec albums (e.g. a FLAC rip kept alongside a couple of MP3 promo tracks). The default is empty — every codec mix is flagged.

**Related warnings:** `warn_quality_inconsistent` — silenced for the codec-mix case when the album's codec set matches a combo listed here. The bitrate-spread case is never silenced by this setting; list specific albums under `albums:` in `ignored/<drive>/music.yaml` instead (note that silences their other warnings too).

**Example:**

```yaml
acceptable_codec_combos:
  - [FLAC, MP3]
```

---

### `acceptable_album_combos`

**Applies to:** music only.

**What it is:** Category sets where the same album may legitimately appear without firing `warn_duplicate_album`. Set-based comparison — order doesn't matter. If your library splits, say, soundtracks across `Music` and a dedicated `Soundtracks` category, listing `[Music, Soundtracks]` tells the scanner that's intentional.

**Why you'd change it:** You intentionally keep the same album in multiple categories. Default empty — every cross-category duplicate is flagged.

**Related warnings:** `warn_duplicate_album` — silenced when an album's category set matches a combo listed here.

**Example:**

```yaml
acceptable_album_combos:
  - [Music, Soundtracks]
```

---

### `acceptable_book_combos`

**Applies to:** audiobooks only.

**What it is:** Category sets where the same book may legitimately appear without firing `warn_duplicate_book`. Same shape as `acceptable_album_combos` (music) and `acceptable_quality_combos` (movies/shows).

**Why you'd change it:** You keep the same book in multiple categories (e.g. an Audible m4b alongside a Book On CD mp3 rip). Default empty — every cross-category duplicate is flagged.

**Related warnings:** `warn_duplicate_book` — silenced when a book's category set matches a combo listed here.

**Example:**

```yaml
acceptable_book_combos:
  - [Audible, Book On CD]
```

---

### `checks`

**Applies to:** all four types.

**What it is:** A flat table of per-warning toggles. Every warning the scanner can emit has a corresponding `warn_*` boolean here. Set one to `false` to silence that warning across the board.

**Why you'd change it:** You've decided a particular warning isn't useful for your library and want to suppress it globally. To silence warnings on specific paths only, use [`ignored/<drive>/<type>.yaml`](#ignoreddrivetypeyaml--silencing-specific-warnings) instead.

**Related warnings:** all of them. See [Output](OUTPUT.md) for the complete warning catalog per media type.

**Example:**

```yaml
checks:
  warn_non_primary: false # silence the "you should re-encode this" nag
```

---

### Validation

Rules are validated at startup against a Zod schema. If your YAML has a typo, wrong type, or invalid regex, you get a clear error before any scanning happens:

```text
Error: rules for movies failed schema validation (sources: rules/movies.yaml + rules/movies.local.yaml):
  - year_range.min: Invalid input: expected number, received string
  - patterns.folder: must be a valid regular expression
```

The defaults live in code at `src/core/rules/<type>.ts` alongside the schema, and a test fails if the committed `rules/<type>.yaml` ever drifts from them.

---

## `ignored/<drive>/<type>.yaml` — silencing specific warnings

For warnings you can't or don't want to fix (an incomplete season that never aired, a folder name you've decided not to change, a known false positive), drop an ignore file under that drive's folder. Matching warnings are silently dropped from `warnings.json` and `validation-warnings.json`, and counted in the run summary.

Ignore lists are **per drive** as well as per type, because warning paths are relative to that drive's `root_path` — the same relative path can mean different files on different drives.

```text
ignored/
├── movies.yaml.example         ← reference files with commented examples
├── shows.yaml.example
├── music.yaml.example
├── audiobooks.yaml.example
├── server/                     ← one folder per root name in config.json
│   ├── movies.yaml
│   ├── shows.yaml
│   └── music.yaml
└── external/
    ├── movies.yaml
    └── shows.yaml
```

Each `.yaml.example` at the top level ships with commented usage patterns. To use: copy it to `ignored/<drive>/<type>.yaml` (lowercase drive name, drop the `.example` suffix) and uncomment / edit the entries you need. A drive with nothing to silence needs no file — and no folder — at all.

**You rarely need to write an entry from scratch.** Every row in a `*warnings.json` file carries an `ignore` field with the narrowest entry that silences it — `"ignore": "seasons: Firefly (2002)/Season 01"` means add `- Firefly (2002)/Season 01` under `seasons:`. See [Silencing a row](OUTPUT.md#silencing-a-row).

### Entries are bare names, grouped by level

```yaml
# ignored/server/shows.yaml — gitignored, per-user
folders:
  - Other HD
shows:
  - Firefly (2002)
seasons:
  - Comedy Central Presents (1998)/Season 3
episodes:
  - My Name Is Earl (2005)/S03E01
```

Each media type has its own set of level keys, outermost first:

| Type       | Level 0   | Level 1   | Level 2   | Level 3    |
| ---------- | --------- | --------- | --------- | ---------- |
| Movies     | `folders` | `movies`  | `files`   | —          |
| Shows      | `folders` | `shows`   | `seasons` | `episodes` |
| Music      | `folders` | `artists` | `albums`  | `songs`    |
| Audiobooks | `folders` | `authors` | `books`   | `chapters` |

A key from the wrong type (`episodes:` in `movies.yaml`) is a load-time error rather than a list that silently silences nothing.

### Names are category-independent

A name is matched at its own level, **not** as a path from the root — so `shows: Firefly (2002)` silences that show whether it lives in `HD/`, `Other SD/`, or both, and keeps working if you move it between categories later.

That's also what makes the cross-category checks reachable. `warn_multi_quality`, `warn_duplicate_quality`, `warn_duplicate_album` and `warn_duplicate_book` report a display label with no category in it (`Firefly (2002) — Season 1`), so no path-based entry could ever match them. A level-keyed entry can.

### Qualifiers

The deepest level (`files`, `episodes`, `songs`, `chapters`) and `seasons` must name a parent — a bare `09 - Chapter 9.mp3` or `Season 01` would match in every book or show in the library, so the loader rejects it. `albums` and `books` accept either form; qualify them when the name isn't distinctive on its own.

A `/` in an entry means **"somewhere above"**, not "immediately above", so intermediate levels can be skipped:

```yaml
episodes:
  - My Name Is Earl (2005)/S03E01 # show → episode, skipping the season
songs:
  - Pink Floyd/01 - In the Flesh.flac # artist → song, skipping the album
```

### Scope

An entry silences **every** warning at or below its level — there is no per-warning-type scoping. To silence a whole warning type instead, set `checks.warn_*: false` in `rules/<type>.yaml`. The two are complementary: the ignore list is per item, `checks` is per check.

An entry never reaches a warning shallower than itself — a `seasons:` entry can't silence a show-level warning like `warn_bad_show_folder`.

### Matching rules

- **Exact per level**, not a prefix: `Firefly (2002)` does not match `Firefly Serenity (2005)`.
- **Case-insensitive and separator-normalized**: either slash works, so the same file is correct on Windows and macOS/Linux.
- **Shows fold `Season 3` and `Season 03` onto one entry.** The scan pass reports the on-disk folder name; the TMDB pass reports the parsed season number.
- **Shows treat an episode's filename and its `S03E01` code as the same episode.** Write an `episodes:` entry either way and it covers the scan pass's file warnings and the TMDB pass's episode-title warning alike.

The `<type>.yaml` files are **gitignored** since they encode per-library decisions that don't belong in the shared repo. Missing or comments-only files are treated as "no ignores."

The run summary surfaces how many warnings were silenced:

```text
Done — 131 entries, 18 warnings, 5 silenced via ignore list.
```

---

## `.secrets.json`

Credentials live in `.secrets.json` at the project root, which is gitignored. Copy `.secrets.json.example` and fill in only the blocks you use — each command validates just the block it needs, so an unfilled placeholder for a feature you don't use never gets in the way.

```json
{
  "tmdb": { "api_key": "your-tmdb-v3-api-key" },
  "plex": { "token": "your-plex-token" }
}
```

| Block  | Needed by                                                                  | How to get it                                                                                                 |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `tmdb` | `validate:movies`, `validate:shows` (skipped by `validate:all` if missing) | A free v3 API key — see [TMDB's getting-started guide](https://developer.themoviedb.org/docs/getting-started) |
| `plex` | `plex:pull`, `plex:check`, `plex:logs`                                     | Your `X-Plex-Token` — see [Plex setup](PLEX.md#2-token--secretsjson)                                          |

`validate:audiobooks` uses Open Library and needs no key. A missing, malformed, or still-placeholder block fails at startup with instructions, before any requests are made.
