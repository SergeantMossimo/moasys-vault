# Output & Warning Reference

This page is the complete reference for what the scanner writes and every warning it can emit.

- For workflow guidance see [Scans](SCANS.md).
- For folder/file naming conventions see [Conventions](CONVENTIONS.md).
- For machine-readable shapes (JSON Schema Draft 2020-12) of every output file, see [`schemas/`](../schemas/) at the repo root.

---

## Output files

Every run writes its files under `output/<drive>/<type>/`, where `<drive>` is the lowercased `name` of the root you scanned (see [Configuration](CONFIG.md#configjson)). There are up to five files per media type, per drive:

| File                       | Written by                           | What it is                                                               |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `<type>.json`              | scan (`npm run <type>`)              | Your catalog — title, year, where each copy lives                        |
| `probe.json`               | scan                                 | Raw per-file inspection data (codec, bitrate, dimensions, embedded tags) |
| `warnings.json`            | scan                                 | Every hygiene finding from the scan pass                                 |
| `validation.json`          | validate (movies, shows, audiobooks) | TMDB cross-check results (Open Library for audiobooks)                   |
| `validation-warnings.json` | validate (movies, shows, audiobooks) | Confidence warnings and title/year/author mismatches                     |

The validate files only appear after you run `npm run validate:<type>`. Movies and shows validate against TMDB, audiobooks against Open Library; music has no validate pass and never produces validate files.

Full layout, for a config with a `Server` root on every type and an `External` root on movies and shows:

```text
output/
├── server/
│   ├── movies/
│   │   ├── movies.json
│   │   ├── probe.json
│   │   ├── warnings.json
│   │   ├── validation.json
│   │   └── validation-warnings.json
│   ├── shows/
│   │   ├── shows.json
│   │   ├── probe.json
│   │   ├── warnings.json
│   │   ├── validation.json
│   │   └── validation-warnings.json
│   ├── music/
│   │   ├── music.json
│   │   ├── probe.json
│   │   └── warnings.json
│   └── audiobooks/
│       ├── audiobooks.json
│       ├── probe.json
│       ├── warnings.json
│       ├── validation.json
│       └── validation-warnings.json
└── external/
    ├── movies/
    │   ├── movies.json
    │   ├── probe.json
    │   └── warnings.json
    └── shows/
        ├── shows.json
        ├── probe.json
        └── warnings.json
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

- **No `year` on music or audiobook catalogs.** Movies and shows have a `year` field; music and audiobooks don't. Album release years live in the embedded music tags and are exposed in `probe.json` under each track's `tags.year`; audiobooks have no defined year.
- **`"default"` is the category sentinel.** When your library uses no subfolders (empty `categories` config), every version's `category` will be the literal string `"default"`. You can group by category safely without special-casing flat libraries.
- **`authors` is always a string array.** Even single-author books come through as `["Single Author Name"]`, so consumers don't need to handle both shapes.
- **`title` can be `null` on `episodes[]`.** When an episode filename omits the trailing `- Episode Title`, the `title` field is `null` rather than an empty string. Same applies elsewhere — null means "intentionally absent," never `undefined` or missing key.
- **`quality` can be `null` on a `version`.** This means the file didn't fit any configured `quality_thresholds` bucket (movies/shows) or the file had no codec data (rare; usually a probe failure). Surface it as "unknown quality" in your UI.

### `warnings.json` (shape shared across scan + validate)

Warnings are grouped by their `type` (the same identifier as the matching `checks.warn_*` toggle in `rules/<type>.yaml`) under `by_type`. Each row in a bucket carries a `path` and human-readable `issue`; some rows also carry an `extension`. Buckets are sparse — only types that actually fired appear as keys. Inside each bucket, rows are sorted alphabetically by path; the outer keys are sorted alphabetically too, so the file diffs cleanly across runs.

One bucket orders itself differently: `warn_duplicate_quality` groups by quality first — every UHD row, then HD, then SD — with paths sorted alphabetically inside each quality group. Duplicates of your best copies are the ones worth acting on first, so they read together at the top rather than scattered through an alphabetical list. Ordering is still fully deterministic, so the file diffs cleanly across runs either way.

```json
{
  "generated": "2026-04-20T10:30:00+00:00",
  "count": 12,
  "by_type": {
    "warn_non_primary": [
      {
        "path": "UHD/The Terminator (1984)/The Terminator (1984).mkv",
        "extension": ".mkv",
        "issue": "Non-.MP4 video file — may need re-encoding"
      }
    ],
    "warn_tmdb_no_match": [
      {
        "path": "UHD/'Twas The Night Before Christmas (1974)",
        "issue": "TMDB found no match for ''Twas The Night Before Christmas' (1974). Possible typo in title or year, or this movie isn't in TMDB."
      }
    ]
  }
}
```

The bucket key (a `warn_*` identifier) is the same string you use under `rules/<type>.yaml` `checks`, so it's copy-pasteable between the two. Ignore lists don't reference warning types at all — they list names by level (see [CONFIG.md](CONFIG.md#ignoreddrivetypeyaml--silencing-specific-warnings)), so `checks: false` is the only way to silence a whole warning _type_.

---

## Warning tables

Every warning has a per-type toggle in `rules/<type>.yaml` under `checks.warn_*`. Warnings ship enabled unless their table row says **Off by default**; set any toggle to `false` to silence that check everywhere. To silence specific items instead, list them by level in `ignored/<drive>/<type>.yaml` — see [Configuration](CONFIG.md#ignoreddrivetypeyaml--silencing-specific-warnings). The two are complementary: `checks` is per check, the ignore list is per item and silences every check on it.

The tables below show the human-readable issue text you'll see in `warnings.json` alongside what triggered it. Warnings marked _(validate pass)_ only appear after `npm run validate:<type>`.

### Movies

| Warning                                         | What it means                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-primary video file — may need re-encoding   | The file exists but isn't your preferred format (set via `primary_extension`)                                                                                                                                                                                                                      |
| No recognized video files found in folder       | A movie folder has no video files (just sidecars or nothing at all)                                                                                                                                                                                                                                |
| File name does not match Plex naming convention | The file won't be picked up by Plex correctly                                                                                                                                                                                                                                                      |
| Empty edition tag                               | The file has `{edition-}` with nothing after the dash                                                                                                                                                                                                                                              |
| Suspicious year                                 | The year is before 1888 or in the future — likely a typo                                                                                                                                                                                                                                           |
| File title does not match folder title          | The file name's title doesn't match its parent folder                                                                                                                                                                                                                                              |
| File title differs only in capitalization       | The file name's title matches its folder except for capitalization. Cosmetic, but Plex and your filesystem then present the same movie two ways                                                                                                                                                    |
| File year does not match folder year            | The file name's year doesn't match its parent folder                                                                                                                                                                                                                                               |
| Duplicate edition                               | Two files in the same folder claim the same `{edition-Name}`                                                                                                                                                                                                                                       |
| Duplicate _Q_ copies in _N_ folders             | The same movie is in two or more folders of the SAME quality tier (`HD/` + `Other HD/`) — redundant files. Not whitelistable                                                                                                                                                                       |
| Movie exists in multiple qualities              | The same movie is in two quality folders (whitelist the combo via `acceptable_quality_combos`)                                                                                                                                                                                                     |
| Loose video files                               | Video files sitting directly in a category folder, not inside a `Movie Title (YEAR)/` folder — these are NOT added to the catalog                                                                                                                                                                  |
| Unexpected subfolder in movie folder            | Subfolders found inside a `Movie Title (YEAR)/` folder — files inside them are NOT scanned                                                                                                                                                                                                         |
| Unexpected file                                 | A non-video file that isn't a recognized Plex sidecar                                                                                                                                                                                                                                              |
| Quality mismatch                                | The file's actual dimensions don't fit the bucket its category implies                                                                                                                                                                                                                             |
| Short runtime                                   | The file's runtime is at or below `min_duration_minutes` — usually a truncated or failed encode. Expect legitimate hits on short films, TV specials and stand-up sets; list those under `movies:` in `ignored/<drive>/movies.yaml`, or turn the check off with `checks.warn_short_duration: false` |
| TMDB no match _(validate pass)_                 | TMDB found nothing matching the title + year, under either the strict or loose comparison — a real typo, a missing diacritic, or an obscure film                                                                                                                                                   |
| TMDB low confidence _(validate pass)_           | TMDB returned a match but the score was below the confidence threshold                                                                                                                                                                                                                             |
| TMDB year mismatch _(validate pass)_            | TMDB's release year disagrees with your folder year                                                                                                                                                                                                                                                |
| TMDB canonical title _(validate pass)_          | Your folder title differs byte-for-byte from TMDB's filename-safe canonical — a rename suggestion. Expected whenever a title matched via the loose tier (`Ghostbusters - Afterlife` → `Ghostbusters Afterlife`)                                                                                    |
| TMDB runtime mismatch _(validate pass)_         | The file's runtime differs from TMDB's by more than `runtime_tolerance_percent`. Shorter means a truncated encode; longer means a wrong match, two features in one file, or an extended cut TMDB lacks                                                                                             |
| Probe failed                                    | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml`          |

### Shows

| Warning                                           | What it means                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-primary video file — may need re-encoding     | The file exists but isn't your preferred format                                                                                                                                                                                                                                           |
| No recognized video files found in season folder  | A season folder has no video files                                                                                                                                                                                                                                                        |
| Show folder does not match Plex naming convention | Expected: `Show Title (YEAR)`                                                                                                                                                                                                                                                             |
| Season folder does not match expected format      | Expected: `Season 01`. Special-season names like `Specials` are whitelisted in `ignored_season_names`                                                                                                                                                                                     |
| File name does not match Plex naming convention   | Expected: `Show Title (YEAR) - S01E01 - Episode Title` (episode title optional)                                                                                                                                                                                                           |
| File show/year does not match show folder         | The episode file's show name or year doesn't match its parent show folder                                                                                                                                                                                                                 |
| File show title differs only in capitalization    | The episode file's show title matches its folder except for capitalization                                                                                                                                                                                                                |
| File season does not match season folder          | The episode file is in the wrong season folder                                                                                                                                                                                                                                            |
| Potential missing episodes                        | A gap was detected in episode numbers within a season                                                                                                                                                                                                                                     |
| Missing episode titles                            | Episodes in this season match Plex's naming convention but omit the trailing `- Episode Title` portion. Summarised once per season.                                                                                                                                                       |
| Episode code case                                 | Episode codes in this season don't match the `episode_code_case` house style, or a multi-episode file uses the bare `-02` suffix instead of `-e02`. Summarised once per season; never fires when `episode_code_case` is `any`                                                             |
| Loose video files                                 | Episode files directly in a category folder or in a show folder (no `Season XX` wrapper) — NOT added to the catalog                                                                                                                                                                       |
| Unexpected subfolder in season folder             | Subfolders found inside a `Season XX/` folder — files inside them are NOT scanned                                                                                                                                                                                                         |
| Unexpected file                                   | A non-video file that isn't a recognized Plex sidecar                                                                                                                                                                                                                                     |
| Quality mismatch                                  | The file's actual dimensions don't fit the bucket its category implies                                                                                                                                                                                                                    |
| Season has duplicate _Q_ copies in _N_ folders    | A single season is in two or more folders of the SAME quality tier (`HD/` + `Other HD/`) — redundant files. Not whitelistable                                                                                                                                                             |
| Season exists in multiple qualities               | A single season has copies in two quality folders (whitelist via `acceptable_quality_combos`)                                                                                                                                                                                             |
| TMDB no match _(validate pass)_                   | TMDB found nothing matching the title + year, under either the strict or loose comparison                                                                                                                                                                                                 |
| TMDB low confidence _(validate pass)_             | TMDB match score below the confidence threshold                                                                                                                                                                                                                                           |
| TMDB episode count _(validate pass)_              | Your local season has fewer episodes than TMDB lists                                                                                                                                                                                                                                      |
| TMDB episode title mismatch _(validate pass)_     | An episode's filename title doesn't match TMDB's title for that episode. Strict, filename-safe comparison.                                                                                                                                                                                |
| TMDB canonical title _(validate pass)_            | Your folder title differs byte-for-byte from TMDB's filename-safe canonical — a rename suggestion. Expected whenever a title matched via the loose tier                                                                                                                                   |
| Probe failed                                      | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml` |

### Music

| Warning                                          | What it means                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-primary audio file — may need re-encoding    | The file exists but isn't one of your preferred formats                                                                                                                                                                                                                                   |
| No recognized audio files found in album folder  | An album folder has no audio files                                                                                                                                                                                                                                                        |
| Track file name does not match naming convention | Expected: `01 - Track Name.ext` (single-disc) or `101 - Track Name.ext` (multi-disc)                                                                                                                                                                                                      |
| Artist folder name does not match pattern        | The artist folder doesn't match `patterns.artist_folder` (default is permissive)                                                                                                                                                                                                          |
| Album folder name does not match pattern         | The album folder doesn't match `patterns.album_folder` (default is permissive)                                                                                                                                                                                                            |
| Suspicious characters in folder name             | Trailing whitespace, Windows-illegal characters, or a reserved name — these silently fragment Plex                                                                                                                                                                                        |
| Potential missing tracks                         | A gap was detected in track numbers within an album (checked per-disc)                                                                                                                                                                                                                    |
| Duplicate album                                  | The same artist + album appears in more than one category                                                                                                                                                                                                                                 |
| Loose audio files                                | Audio files in a category folder root or in an artist folder (no album wrapper) — NOT added to the catalog                                                                                                                                                                                |
| Unexpected subfolder in album folder             | Subfolders found inside an album — files inside them are NOT scanned                                                                                                                                                                                                                      |
| Unexpected file                                  | A non-audio file that isn't a recognized sidecar                                                                                                                                                                                                                                          |
| Inconsistent audio quality                       | The album mixes codecs (FLAC + MP3) or has a wide bitrate spread (>64 kbps). Codec mixes can be whitelisted via `acceptable_codec_combos`.                                                                                                                                                |
| Compilation detected                             | The album has multiple distinct AlbumArtist values — likely belongs under `Various Artists/`                                                                                                                                                                                              |
| Folder/tag mismatch                              | The folder name disagrees with the embedded tag (artist or album)                                                                                                                                                                                                                         |
| Folder/tag capitalization                        | The folder name matches its embedded tag except for capitalization (artist or album)                                                                                                                                                                                                      |
| Missing tags                                     | Tracks are missing required embedded tags (title, album, or artist)                                                                                                                                                                                                                       |
| Track number mismatch                            | The filename's track number disagrees with the embedded tag's track number                                                                                                                                                                                                                |
| Mono audio                                       | The album contains tracks encoded as mono (single channel). Summarised once per album: "N of M tracks are mono". Most modern music should be stereo.                                                                                                                                      |
| Probe failed                                     | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml` |

### Audiobooks

| Warning                                             | What it means                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-primary audio file — may need re-encoding       | The file exists but isn't one of your preferred formats                                                                                                                                                                                                                                   |
| No recognized audio files found in book folder      | A book folder has no audio files                                                                                                                                                                                                                                                          |
| Chapter file name does not match naming convention  | Expected: `01 - Chapter Name.ext` (single-disc) or `101 - Chapter Name.ext` (multi-disc)                                                                                                                                                                                                  |
| Potential missing chapters                          | A gap was detected in chapter numbers within a book (checked per-disc)                                                                                                                                                                                                                    |
| Duplicate book                                      | The same book title appears in more than one category                                                                                                                                                                                                                                     |
| Loose audio files                                   | Audio files in a category folder root or in an author folder (no book wrapper) — NOT added to the catalog                                                                                                                                                                                 |
| Unexpected subfolder in book folder                 | Subfolders found inside a book — files inside them are NOT scanned                                                                                                                                                                                                                        |
| Unexpected file                                     | A non-audio file that isn't a recognized sidecar                                                                                                                                                                                                                                          |
| Series name mismatch                                | The same series is spelled differently across books (`Gaunt's Ghost, Book 1` vs `Gaunt's Ghosts, Book 2`) — a plural slip, a typo one character off, or punctuation drift. The spelling most books use is recommended as the rename                                                       |
| Series name capitalization                          | A series name or title prefix differs only in capitalization across books (`HALO - Legacy of Onyx` vs `Halo - The Flood`)                                                                                                                                                                 |
| Author name mismatch                                | The same author is written two ways (`Tobias S. Buckell` vs `Tobias Buckell`, `J.R.R.` vs `J. R. R.`), including inside multi-author folders. Plex treats them as separate people                                                                                                         |
| Author name capitalization                          | An author name differs only in capitalization across books                                                                                                                                                                                                                                |
| Encoded characters                                  | A book or author folder contains HTML entities (`&quot;`, `&amp;`) instead of the actual characters — usually left by a download tool                                                                                                                                                     |
| Mixed punctuation                                   | A folder name uses curly quotes where most of the library uses straight ones (or the reverse). Full-width stand-ins for filename-illegal characters (`？`, `꞉`) are not flagged                                                                                                           |
| Book tag mismatch                                   | The album tag names a different book than the folder. Audible conventions are normalized first — `(Unabridged)`, a colon where the folder has a dash, and a folder that adds a subtitle or series all still match                                                                         |
| Book tag capitalization                             | The album tag matches the folder except for capitalization (Audible tags often use `HALO:` where folders use `Halo -`)                                                                                                                                                                    |
| Author tag mismatch                                 | The artist tag names different authors than the author folder. Order and role suffixes (`Danusia Stok - translator`) are ignored; different initials or spacing still count, and the message says so                                                                                      |
| Author tag capitalization                           | The artist tag matches the author folder except for capitalization                                                                                                                                                                                                                        |
| Missing book tags                                   | No chapter in the book carries an album or artist tag                                                                                                                                                                                                                                     |
| Open Library title mismatch _(validate pass)_       | No Open Library title matches, but a book by the same author is a typo's distance away. Verify the spelling; the message gives Open Library's title                                                                                                                                       |
| Open Library title capitalization _(validate pass)_ | Open Library's title differs only in capitalization. **Off by default** — Open Library capitalizes inconsistently itself                                                                                                                                                                  |
| Open Library author mismatch _(validate pass)_      | The title matches an Open Library book, but none of the folder's authors do. Often an author-folder typo; sometimes a different book with the same title                                                                                                                                  |
| Open Library not found _(validate pass)_            | Nothing in Open Library resembles the title. **Off by default** — coverage of tie-in fiction is patchy, and translated books are often listed only under their original title                                                                                                             |
| Probe failed                                        | ffprobe could not read the file. It is excluded from probe output and has no quality data. A file ffprobe rejects is usually unplayable in Plex too — verify it plays and re-copy it if not. Has no toggle (like `permission_denied`); silence per item via `ignored/<drive>/<type>.yaml` |
