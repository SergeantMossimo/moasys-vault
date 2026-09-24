# Scans & Validation

The day-to-day guide: how to run MOASYS-Vault, what each pass does, and how long it takes.

| Pass                                                      | Command                            | What it does                                                                                        |
| --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Scan](#scan-pass)                                        | `npm run <type> [drive]`           | Inspects every file and walks your folders. Writes your catalog and a list of hygiene issues.       |
| [Validate](#validate-pass)                                | `npm run validate:<type> [drive]`  | Cross-checks the catalog against TheMovieDB (movies, shows) or Open Library (audiobooks). Optional. |
| [Plex](PLEX.md)                                           | `npm run plex:pull` / `plex:check` | Compares what Plex has with what's on disk. Optional.                                               |
| [Report](#merged-report)                                  | `npm run report [drive]`           | Folds every pass's warnings into one entry per folder. The file you actually work from.             |
| [Fix show filenames](#fixing-filenames--npm-run-fixshows) | `npm run fix:shows`                | Renames flagged episode files. The only command that writes to your library.                        |

Every command takes an optional drive name — a root's `name` from `config.json`. Leave it off and each type uses its first root. Drives are scanned independently and never merged; see [Selecting a drive](CONFIG.md#selecting-a-drive).

---

## Workflow

### First run

```bash
npm install
cp config.example.json config.json   # then edit the paths — see Configuration

npm run scan:all                     # slow once: every file gets inspected (see Speed below)
npm run scan:all external            # repeat for each extra drive, if you have one
```

Then, optionally, set up the cross-checks:

- **Validation** — add a free TMDB key to `.secrets.json` (see [Setup](#setup)), then `npm run validate:all`. Audiobooks validate against Open Library with no key.
- **Plex** — add your server address and token (see [Plex setup](PLEX.md#setup)), then `npm run plex:pull` and `npm run plex:check`.

### Routine refresh

Once set up, one command runs every routine pass for a drive, in dependency order:

```bash
npm run all                          # scan → validate → plex pull → plex check → report
npm run all external                 # the same, for the root named "External"
npm run all -- --no-plex --no-validate
npm run all -- --no-report           # skip just the merged report
```

Steps that aren't set up are skipped with the reason — no TMDB key skips movie and show validation (audiobooks still validate), and no `plex` block or token skips both Plex steps. A failing step stops the run. `plex:logs` isn't included, and `fix:shows` never is.

### Command order

`npm run all` handles the order for you. Running commands individually, each one reads what an earlier one wrote:

| Order | Command                                     | Needs first                                                                |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | `npm run scan:all [drive]`                  | `config.json`                                                              |
| 2     | `npm run validate:all [drive]`              | The scan (reads its catalog); a TMDB key for movies and shows              |
| 3     | `npm run plex:pull`                         | Plex `url` in `config.json` and a token in `.secrets.json`                 |
| 4     | `npm run plex:check [drive]`                | The scan and the pull; compares TMDB ids when validation has run           |
| 5     | `npm run report [drive]`                    | Nothing — it merges whichever of the above have run, and names the rest    |
| 6     | `npm run plex:logs [drive]`                 | The pull; the server owner's token. Occasional — not part of `npm run all` |
| 7     | `npm run fix:shows -- --fix <mode> <drive>` | The scan; `episode-titles` also needs validation. Always run by hand       |

`npm run report` runs last because it folds together what the others wrote. It reads only files under `output/`, never your library, so it works with the drive unplugged — and a command you haven't run is listed in the report's `sources` block with a null count rather than silently looking clean.

### After pulling updates

```bash
git pull
npm ci          # install exactly what package-lock.json lists
npm run all
```

Your `config.json`, `.secrets.json`, `rules/*.local.yaml`, ignore lists, `output/`, and `cache/` are all gitignored, so a pull never changes them, and warm caches keep the run short. If a release changes an output layout, the commands say which old files can be deleted — see the [Changelog](../CHANGELOG.md).

### After changing your library

Work through `output/<drive>/<type>/all-warnings.json` — one entry per show, movie, artist, or author, listing everything every command found on it, so you fix one item at a time instead of joining findings across four files. ([Output](OUTPUT.md#all-warningsjson-the-merged-report) explains the shape, and the per-command files behind it.) Then re-run what your change affects:

| You changed...                                   | Re-run                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| Renamed/moved folders or files                   | `npm run <type>` — scan                                              |
| Updated embedded music or audiobook tags         | `npm run music` / `npm run audiobooks`                               |
| Fixed an audiobook title or author               | `npm run audiobooks` then `npm run validate:audiobooks`              |
| Replaced a media file (different format/bitrate) | `npm run <type>` — the cache invalidates on modification time + size |
| Fixed a movie/show title or year                 | `npm run <type>` then `npm run validate:<type>`                      |
| Added new content                                | `npm run <type>` — only the new files get inspected                  |

---

## Scan pass

`npm run <type> [drive]`, or `npm run scan:all [drive]` for every type. For one media type on one drive, the scan:

1. **Inspects every primary file.** Records video dimensions, audio codec/bitrate/sample rate, and (for music and audiobooks) the tags embedded in the file. Results are cached, so later runs skip unchanged files. A cache entry from before tags were read for that type gets its tags backfilled once — a quick header read, not a re-inspection.
2. **Walks the folder tree.** Goes through the configured `categories` (or `root_path` directly if there are none), parses each folder and file name against the [naming conventions](CONVENTIONS.md), and uses the inspection data to work out each copy's quality.
3. **Writes** `<type>.json` (your catalog), `warnings.json` (every issue from steps 1 and 2), and `data/probe.json` (the inspection data the validate and Plex commands read) under `output/<drive>/<type>/`. See [Output](OUTPUT.md).

### Speed

The first scan of a library is the slow one — inspecting a file takes 100–300 ms. After that only new or changed files are inspected, so a re-scan takes seconds on a local disk and a minute or two for a large library on a network share, where just listing the files takes time.

| First run         | Time       |
| ----------------- | ---------- |
| 2,500 movies      | ~12–20 min |
| 5,000 episodes    | ~15–25 min |
| 7,000 tracks      | ~10 min    |
| 3,500 chapters    | ~6 min     |
| `validate:movies` | ~10 min    |
| `validate:shows`  | ~3 min     |

**Faster first scans.** On an SSD or network share, set `probe_concurrency` on the root in `config.json` to inspect several files at once — 4–8 usually cuts the first scan several times over. For a NAS with a RAID array of hard disks, start at about one per disk (4 for a 4-disk RAID 5). Leave it at the default of 1 for a single spinning disk, and lower it while the array is rebuilding or degraded. See [Configuration](CONFIG.md#configjson).

**The cache.** `cache/<drive>/<type>-probe.json` is keyed by `path | modification time | size`, with the path relative to the drive's `root_path`, so replacing or renaming a file re-inspects it. Each drive keeps its own file — a shared one would let one drive's orphan cleanup delete the other's entries. Delete the file to force a full re-inspection.

### Quality buckets (movies and shows)

If your library is organized by quality (folders like `UHD/`, `HD/`, `SD/`), you can tell the scanner what those names mean in terms of pixel dimensions:

```yaml
quality_thresholds:
  - name: UHD
    min_width: 2000
  - name: HD
    min_width: 1000
    max_width: 2000
  - name: SD
    max_width: 1000
```

Each bucket's `name` is one of the recognized quality keywords (`UHD`, `HD`, or `SD`) — the same words the scanner auto-detects from your category names. Two things happen for every video file:

1. **Quality derivation** — the bucket whose width range contains the file's long edge becomes the version's `quality`. This happens regardless of which folder the file is in.
2. **`warn_quality_mismatch`** — every category resolves to a quality via whole-word matching of `UHD` / `HD` / `SD` in its name. So `UHD/` and `Other UHD/` both resolve to UHD, `HD/` resolves to HD, etc. Categories without any of those keywords (e.g. `Documentary/`) resolve to `null` and skip the check entirely. When a file's category-resolved quality has a matching bucket and the file's actual long edge doesn't fit, you get a warning.

So: a 480p file in `Other HD/` gets flagged (Other HD → HD bucket), but a 480p file in `Documentary/` doesn't (no quality detected — general tag).

These checks are forgiving by design — HandBrake-cropped 664×448 SD and 1920×800 HD both classify correctly. And `quality_thresholds` ships empty by default, so libraries that aren't organized by quality stay quiet.

See [Configuration](CONFIG.md#three-configuration-shapes) for the full configuration matrix.

### Short runtime (movies)

The probe pass also knows how long each file actually is, and `warn_short_duration` flags any movie file whose runtime is **at or below** `min_duration_minutes` (default 30). It's **off by default** because the [TMDB runtime cross-check](#tmdb-runtime-cross-check-movies) does the same job more precisely; turn it on with `checks.warn_short_duration: true` if you don't run validation. The thing worth catching is a truncated or failed encode — a 4-minute file where a 2-hour film should be, or a zero-length container that won't play at all.

Unlike `warn_quality_mismatch`, this isn't gated on the category's quality, so it fires in general-tag categories like `Documentary/` too. Files whose duration ffprobe couldn't read are skipped — those already fire `warn_probe_failed`.

#### A known false positive: legitimate short films

Plenty of things in a movie library are genuinely under 30 minutes — on a large library expect this check to fire on a couple of hundred files, most of them fine: Pixar shorts (_Luxo Jr._ 2m, _For the Birds_ 3m), animated TV specials (_The Snowman_ 27m, _Shrek the Halls_ 28m), Marvel one-shots (_Team Thor_ 2m), and stand-up specials (_Louis C.K. One Night Stand_ 29m).

So treat this one as a **review list, not an error list** — walk it once, confirm the genuinely short titles, and list them in `ignored/<drive>/movies.yaml`:

```yaml
movies:
  - Luxo Jr. (1986)
```

Note that silences the film's _other_ warnings too — naming, TMDB, quality. That's the trade the ignore list makes: it's scoped per item, not per check. If short films are noisy across the whole library rather than on a handful of titles, leave the check off and rely on the TMDB runtime cross-check instead.

Resist the temptation to lower `min_duration_minutes` to make the noise go away — that also throws away the truncated-encode signal, which is the entire point.

The precise version of this check lives in the validate pass — see [TMDB runtime cross-check](#tmdb-runtime-cross-check-movies) below. If you run `npm run validate:movies`, that is the list to work from; `warn_short_duration` is the offline approximation for when you haven't validated.

### Audio quality summary (music)

Each album in `output/<drive>/music/data/probe.json` gets a derived `audio_quality_summary` field — short, human-readable strings like `"FLAC 16/44.1"`, `"MP3 ~288"`, or `"AAC 256"`. The summary collapses tracks that share a codec and roughly the same bitrate target into one entry, so a VBR-encoded album doesn't list ten different bitrates.

Albums where the tracks have truly mismatched quality (FLAC mixed with MP3, or a very wide bitrate spread) get a `warn_quality_inconsistent` warning so you know which albums to clean up.

### Embedded music tags

Music files carry metadata embedded inside them — title, artist, album, year, track number, genre, and so on. The scanner reads these tags during the file inspection pass and stores them per track in `output/<drive>/music/data/probe.json` under a `tags` field.

Five warnings are driven from the tag data:

- **`warn_compilation_detected`** — the album has multiple distinct AlbumArtist values, which usually means it belongs under `Various Artists/`
- **`warn_folder_tag_mismatch`** — the folder name (artist or album) disagrees with what's embedded in the file
- **`warn_folder_tag_case`** — the folder name matches the tag except for capitalization
- **`warn_missing_tags`** — required tag fields (title / album / artist) are blank
- **`warn_track_number_mismatch`** — the track number in the filename (`01 - ...`) doesn't match the track number embedded in the file

#### A known false positive: hip-hop / collaboration-heavy albums

Hip-hop and other collaboration-heavy albums often tag each track's `AlbumArtist` as `<Primary Artist> feat. <Different Guest>` — so every track has a _different_ AlbumArtist string, even though it's really one artist's album with rotating guests. (Example: 2Pac's _All Eyez on Me_ has 10 distinct AlbumArtist values like "2Pac feat. Outlaw Immortalz", "2Pac feat. Danny Boy", etc.)

This trips `warn_compilation_detected` because the scanner can't tell "10 different artists collaborating" from "one artist with 10 different guests" — both look the same in the tag data.

The right fix is **not** to move these albums under `Various Artists/`. Instead, fix the tags so every track lists the primary artist as `AlbumArtist`, with the featured guest staying in the per-track `Artist` field. That makes the album consistent under one artist — which is what Plex recommends for single-artist albums with guest features.

If you find a stack of these in your warnings, that's the pattern.

---

## Validate pass

`npm run validate:<type> [drive]`, or `npm run validate:all [drive]`.

Cross-checks your scan output against TheMovieDB (movies, shows) or Open Library (audiobooks — see [Audiobooks against Open Library](#audiobooks-against-open-library) below). Music has no validate pass.

Reads `output/<drive>/<type>/<type>.json`, so run the scan for that same drive first. Writes alongside it:

- `output/<drive>/<type>/validation-warnings.json` — confidence warnings and canonical-title rename suggestions
- `output/<drive>/<type>/data/validation.json` — per-record TMDB resolution (canonical title, year, TMDB ID, alternatives), read by `plex:check` and `fix:shows`

### Setup

1. Get a free [TMDB API v3 key](https://developer.themoviedb.org/docs/getting-started)
2. Copy `.secrets.json.example` to `.secrets.json`
3. Paste your key into the `tmdb.api_key` field

See [Configuration](CONFIG.md#secretsjson) for details.

### What it catches

**For movies:**

- Title typos (`Justice League Unlimitied` → no match)
- Year off by one (Casablanca 1942 vs TMDB's 1943 — premiere vs wide release)
- Title canonicalization opportunities (your `Alice In Wonderland` → TMDB's `Alice in Wonderland`)
- Obscure films that aren't in TMDB at all
- Runtime that disagrees with TMDB's — see below

#### TMDB runtime cross-check (movies)

`warn_tmdb_runtime_mismatch` compares each file's measured runtime (from `data/probe.json`, so the scan must have run first) against TMDB's, and fires when they differ by more than `runtime_tolerance_percent` — 50% by default, symmetric in both directions.

This is the precise counterpart to [`warn_short_duration`](#short-runtime-movies). Where that check flags everything under 30 minutes and buries real problems under 200 legitimate short films, this one knows how long the film is _supposed_ to be:

- **Far shorter than TMDB** — a truncated or failed encode. A feature that arrived as a 5-minute sample is caught no matter how long the real film is, and a genuine 2-minute Pixar short matches TMDB's 2 minutes and stays silent.
- **Far longer than TMDB** — a wrongly-matched film, two features concatenated into one file, or an extended cut TMDB doesn't carry.

The over-length direction catches a class of error that title + year scoring is structurally blind to. A 5-minute short film sharing a feature's exact title and release year scores `high` confidence — every signal the matcher looks at agrees. Only the runtime gives it away.

Extended and director's cuts will fire here legitimately when TMDB carries only the theatrical runtime. List those under `files:` in `ignored/<drive>/movies.yaml` (which silences that file's other warnings too), or turn the check off with `checks.warn_tmdb_runtime_mismatch: false`.

**For shows (everything above plus):**

- **Missing episode counts** — your local gap detection only catches missing-in-the-middle episodes. TMDB validation catches "TMDB says season 5 has 23 episodes; you have 22." That trailing missing episode finally gets flagged.
- **Episode title mismatches** — each episode file's trailing `- Episode Title` is compared against TMDB's episode title for that S/E number, using the same strict-then-loose two-tier comparison described below. The loose tier matters here: Windows silently drops trailing periods, so `All Good Things...` and `T.R.A.C.K.S.` _cannot_ exist on disk in canonical form, and a strict-only comparison would flag them forever. Multi-episode files (`S01E01-E02`) are skipped by default because their combined titles rarely match strictly; enable `warn_tmdb_episode_name_multi_episode` if you want them checked too. Costs one extra TMDB call per season — cached in `cache/tmdb-show-seasons.json`.

### How matching works

Titles are compared in two tiers, because a filename-illegal character (`<>:"|?*\/`) can be rendered in a folder name more than one way.

**Strict tier.** Illegal characters are _deleted_, then the result is lowercased and whitespace-collapsed. This catches the case where you dropped the character outright: TMDB's `Face/Off` and your folder `FaceOff` both reduce to `faceoff`.

**Loose tier.** Illegal characters become a _separator_ instead, `-` collapses to a space, `&` reads as `and`, and stray commas and periods are dropped. This catches the case where you substituted for the character rather than deleting it — which is what most people do with a subtitle colon:

| Your folder                | TMDB                      | Matches via |
| -------------------------- | ------------------------- | ----------- |
| `Ghostbusters - Afterlife` | `Ghostbusters: Afterlife` | loose       |
| `Pain And Gain`            | `Pain & Gain`             | loose       |
| `Good Morning Vietnam`     | `Good Morning, Vietnam`   | loose       |
| `FaceOff`                  | `Face/Off`                | strict      |

Neither tier subsumes the other, so both run.

Both tiers stay strict about everything that _is_ legal in a filename. Diacritics are never folded — your `Amelie` won't match TMDB's `Amélie`, and `Halloween H2o` won't match `Halloween H20`. Those are real divergences, surfaced as `no_match` so you can decide.

When a match is found:

- A `tmdb_title_filename_safe` field is included in the output — a copy-pasteable rename target
- If your folder differs from that target **byte-for-byte**, `warn_tmdb_title_canonical` fires. A loose-tier match will normally trip this, which is the point: it turns a dead-end `no_match` into a concrete rename suggestion.

Confidence is scored from title-match strength plus year-match closeness (exact / off-by-1 / off-by-2 / wider). Thresholds:

- **high** (≥ 150) — title exact (strict) + year exact
- **medium** (≥ 110) — title exact + year off by one, loose title match + year exact, or prefix + year exact
- **low** (≥ 60) — partial title match + close year
- **none** (< 60) — no plausible candidate; warning fires

A **medium** from the loose tier means "this is the right film, but your folder name isn't byte-identical to TMDB's" — no confidence warning fires, and `warn_tmdb_title_canonical` carries the rename target.

### Caching

Four caches keep TMDB calls minimal:

- `cache/tmdb-search.json` — search-query to resolved-match lookup
- `cache/tmdb-movies.json` — full movie records by TMDB ID
- `cache/tmdb-shows.json` — full show records by TMDB ID
- `cache/tmdb-show-seasons.json` — per-season episode details (titles, air dates), only populated when `warn_tmdb_episode_name_mismatch` is enabled

Unlike the file-inspection cache, these are **not** split per drive — they're keyed by title and year rather than by path, so validating a second drive reuses everything the first one fetched.

All gitignored. Total first-run cost for the example library: ~10 min for movies, ~3 min for shows.

#### Negative results are never cached permanently

One deliberate exception to "re-runs are near-instant": a cached **none** or **low** verdict is always re-queried. Only **high** and **medium** matches are served straight from the cache.

TMDB's search index changes over time, and a title it couldn't find last month may be findable today. `Face/Off` is the worked example — the folder must be named `FaceOff` because `/` is illegal in a filename, and for months TMDB returned nothing for that query. It returns the film now. Without this re-query, that false `warn_tmdb_no_match` would have persisted forever, because nothing ever asked again.

The practical cost is one round-trip per warning-producing entry per run — a few seconds on a healthy library, and it shrinks as you resolve warnings. Everything else stays cached.

#### Refreshing stale entries

Every cache entry is timestamped at fetch time. By default, no entry ever expires — the cache file grows until you delete it. TMDB metadata does change occasionally (year corrections, added seasons, episode title fixes), so you may want to re-fetch entries older than some threshold:

```bash
# Re-fetch any TMDB record fetched more than 30 days ago
npm run validate:movies -- --refresh-older-than=30d
npm run validate:shows -- --refresh-older-than=30d
```

The flag accepts a number of days with optional `d` suffix (`30` and `30d` are equivalent). Without it, every cached entry is used regardless of age. A sensible cadence is once a month or so — the rate limiter throttles re-fetches the same way as fresh ones, so a full refresh is the same wall-clock cost as your first run.

### Rate limiting

The scanner throttles to 4 requests per second (TMDB allows 40 per 10 seconds). Well under the limit, so no tuning needed. If TMDB ever returns a 429, the throttle honors the `Retry-After` header automatically.

### Audiobooks against Open Library

```bash
npm run validate:audiobooks
```

No key and no setup. Each book is searched on [Open Library](https://openlibrary.org/) by title and first author, falling back to the title alone (which is what catches a misspelled author folder) and then to the title's first segment. Series segments (`Gaunt's Ghosts, Book 2`, `Book Two in the Dune Chronicles`) and all-parenthetical edition segments are dropped before searching.

Open Library is community-edited and inconsistent: one book appears as several editions titled `The Flood (Halo)`, `Halo` with subtitle `the flood`, `Star Wars - Thrawn Trilogy - Dark Force Rising`. So the folder title is compared against **every** result, and one matching edition is enough. Case, punctuation, a colon where the folder has a dash, a franchise prefix Open Library leaves off, and series text Open Library pads in are all ignored. What's left to warn about:

- **`warn_openlibrary_title_mismatch`** — nothing matches, but a book by the same author is within a couple of characters. The shape of a typo; the message gives Open Library's spelling.
- **`warn_openlibrary_author_mismatch`** — the title matches but none of your folder's authors do. Usually an author-folder typo, occasionally a different book with the same title. **Off by default**: the scan already compares each author folder against its sibling folders (`warn_author_name_mismatch`) and against the embedded artist tag (`warn_author_tag_mismatch`), so one typo produced three findings for one rename — and Open Library credits narrators, translators and editors as authors.
- **`warn_openlibrary_title_case`** and **`warn_openlibrary_not_found`** — both **off by default**. Open Library's capitalization is unreliable, and translated books are often listed only under their original title (the Witcher novels appear as `Krew elfów` and friends), so these are mostly noise. Turn them on in `rules/audiobooks.local.yaml` for a one-off audit.

Results are cached in `cache/openlibrary-search.json`, shared across drives. Like the TMDB pass, an empty result is never cached, so a book Open Library didn't know is asked again next run. `--refresh-older-than=Nd` works the same way. Requests are held to one per second as Open Library asks; a first run over ~110 books takes about two minutes, and warm runs make no requests.

The scan pass has its own offline name checks for audiobooks that don't need Open Library at all — series and author spelling drift across books, HTML entities in folder names, and embedded tags that disagree with the folders. See the [Audiobooks warning table](OUTPUT.md#audiobooks).

---

## Merged report

`npm run report [drive]`, or `npm run report -- --type shows [drive]` for one type. It runs last in `npm run all`.

Each pass writes its own warnings file, which means one show can be listed in four places. The report folds all of them into `output/<drive>/<type>/all-warnings.json` — **one entry per top-level folder**, listing every finding from every command on that show, movie, artist, or author. That's the file to work from: you fix one item at a time rather than joining four files by hand.

It reads only files under `output/`, never your media library, so it works with the drive unplugged.

### Reading the `sources` block

The report starts by naming every command that can contribute and what each one did — all four, or three for music, which has no validate pass. Read it first:

| `status`     | Means                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `ok`         | Folded in, and no older than the scan                                                                   |
| `stale`      | Older than `warnings.json` — folded in anyway, but it may describe a library that's since changed       |
| `missing`    | That command has never run for this drive and type. Nothing from it is in the report                    |
| `unreadable` | Present but unusable — a damaged file, or one written before warnings were grouped by folder. Re-run it |

A command that hasn't run reports `"count": null`, **not `0`**. That distinction matters: without it, a report covering only the scan would look like a clean library rather than a partial picture. The `note` on each non-`ok` source names the command that refreshes it.

### Why findings aren't deduplicated

Two checks can describe the same season, and both are worth acting on — `warn_episode_gaps` tells you _which_ episodes are missing, `warn_tmdb_episode_count` tells you _how many_ TMDB expects. The report keeps both and just sorts them together: seasons are ordered canonically, so the scan's `Season 03` sits directly above the validate pass's `Season 3`.

See [Output](OUTPUT.md#all-warningsjson-the-merged-report) for the full shape.

---

## Fixing filenames — `npm run fix:shows`

Everything else in MOASYS-Vault is read-only: it tells you what's wrong and you fix it. This one command is the exception, for the cases where "fix it yourself" means renaming thousands of files by hand.

It **only ever renames**. No deletes, no moves between folders, no writes to file contents. Folders are renamed only by `show-folder`, one show you name explicitly per run.

### Safety model

- **The drive name is required.** Unlike `npm run shows`, there is no default-to-first-root — a forgotten argument is an error, not a silent run against your main server.
- **Dry run unless you pass `--apply`.** Every run writes the complete plan to `output/<drive>/shows/fixes/rename-plan.json` for review.
- **Unsafe entries abort the whole run.** A name collision, an illegal character, or an over-long path stops everything before the first rename, so a season is never left half-done.
- **Missing data is not a failure.** Files the tool has no title for are listed as _skipped_ and left alone; the rest of the batch proceeds.
- **Every run writes an undo manifest** to `output/<drive>/shows/fixes/rename-undo-<timestamp>.json` before touching anything.

### Modes

| Mode                 | What it does                                                                                                                                                                                                         | Fixes                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `show-prefix`        | Rewrites each file's `<Title> (<Year>)` prefix to the title and year its show folder names (an `{edition-…}` tag stays on the folder)                                                                                | `warn_show_year_mismatch`, `warn_show_title_case`                                   |
| `episode-titles`     | Appends the trailing `- <Episode Title>` from the TMDB cache                                                                                                                                                         | `warn_missing_episode_title`                                                        |
| `episode-code`       | Normalizes the season/episode code to your `episode_code_case` and the canonical `-e02` multi-episode suffix, and zero-pads unpadded numbers (`s02e4` → `s02e04`)                                                    | `warn_episode_code_case`, `warn_bad_file_name` (unpadded)                           |
| `season-code`        | Rewrites each file's season number to the one its `Season NN` folder names, leaving the episode number and the code's casing alone (`s06e01` → `s01e01`)                                                             | `warn_season_mismatch`                                                              |
| `renumber`           | Gives each file its own episode number where a two-parter was split into two files sharing one code (`s03e18` ×2 → `s03e21`, `s03e22`), or a file reuses a number a multi-episode file covers, shifting what follows | Duplicate episode codes; `warn_tmdb_episode_count` where TMDB merges the parts      |
| `trailing-separator` | Trims separator debris off a name that parses once it is gone (`- s01e12 -.mp4` → `- s01e12.mp4`), the shape left when a title is deleted but its `-` is not                                                         | `warn_bad_file_name` for that shape only                                            |
| `show-folder`        | Renames one show folder, given `--show "<Old Name>"` and `--to "<New Name>"`, in every category that holds it                                                                                                        | `warn_show_year_mismatch`, `warn_show_title_case` when the folder is the wrong side |

When the folder rather than its files is wrong, run `show-folder` first, then `show-prefix` to bring the files in line. The dry run prints the TMDB title and the files' most common prefix as hints — the target is always the one you pass:

```bash
npm run fix:shows -- --fix show-folder external --show "Saved by Bell (1989)" --to "Saved by the Bell (1989)"
```

After a folder rename, re-run `npm run validate:shows <drive>` before `episode-titles` — it looks shows up by folder name.

`season-code` resolves a season mismatch in one direction only: **the folder is right and the code is wrong.** The other reading — that the code is right and the file is simply in the wrong folder — needs the file moved, and this tool never moves anything between directories. Check which side is actually wrong before you `--apply`. Two folders are left alone rather than guessed at: a named season from `ignored_season_names` (`Specials`) has no number to align to and is _skipped_, and a folder the rules reject (`Season  01` with a doubled space) goes to _review_, since renaming the folder is the fix there. Where a season folder holds files from more than one season, every planned entry carries a note, because at least one of those files is misfiled whichever way you read it.

### `trailing-separator` — a name nothing else can see

Deleting an episode title but leaving the `-` that introduced it produces a name that matches neither `patterns.file` nor the lenient fallback:

```text
Hercules (1998) - s01e12 -.mp4
```

That is `warn_bad_file_name`, and it makes the file invisible to **every other mode** — a file has to parse before `show-prefix`, `episode-titles` or `episode-code` can rewrite one part of its name, so those files are not merely skipped, they never enter a plan. This mode exists to get them back to parseable:

```bash
npm run fix:shows -- --fix trailing-separator external --show "Hercules (1998)"
npm run fix:shows -- --fix trailing-separator external --show "Hercules (1998)" --apply
```

The rule is self-verifying: trim trailing whitespace and hyphens, then rename **only if the result matches `patterns.file`**. Nothing is inferred and no target is constructed, so the new name is always a prefix of the old one. A name that still fails to parse once trimmed is reported and left alone — the trailing characters were not its real problem.

A name that parses _with_ its debris is also left alone. `episode_title` is greedy, so `- s01e12 - The Apollo Mission -` matches with the dash inside the title: untidy, but the rules accept it, so trimming it would mean rewriting a valid title on a guess at intent.

Run it before `episode-titles`, then re-scan — the season guard counts files it can parse, so a season full of unreadable names looks partial until they are repaired.

### `renumber` — two files, one episode number

A two-part episode held as two files that both carry the same code is invisible to the scanner but not to Plex, which matches on the episode number and so reads them as two _versions_ of one episode rather than two episodes:

```text
My Name Is Earl (2005) - s03e18 - Camdenites Part 1.mp4
My Name Is Earl (2005) - s03e18 - Camdenites Part 2.mp4
```

`renumber` gives each file its own number. Parts take consecutive numbers in filename order (`Part 1` before `Part 2`, `(1)` before `(2)`), and everything below shifts up by as many extra parts as appeared above it — so the whole season stays in order:

```bash
npm run fix:shows -- --fix renumber server --show "My Name Is Earl (2005)"          # preview
npm run fix:shows -- --fix renumber server --show "My Name Is Earl (2005)" --apply
```

**Gaps are preserved.** The new number is the old one plus an offset, never a re-sequence from 1. A gap means a missing episode (`warn_episode_gaps`), and closing it would renumber the season around a file you still mean to add, leaving every title below the gap on the wrong number. A season whose only oddity is a gap plans nothing at all.

A multi-episode file (`s04e01-e02`) claims every number in its range, so a file after it that reuses one of those numbers — the usual result of a two-part premiere held as one file, with every file after it numbered one low — shifts past the range the same way a duplicate does:

```text
The Middle (2009) - s04e01-e02.mp4        The Middle (2009) - s04e01-e02.mp4
The Middle (2009) - s04e02.mp4       →    The Middle (2009) - s04e03.mp4
The Middle (2009) - s04e03.mp4            The Middle (2009) - s04e04.mp4
```

Each of those entries is flagged for review in the dry run, because the other reading — a single episode mislabelled as a range — needs the multi-episode file renamed instead; check the season against TMDB before `--apply`. Two shapes are still _skipped_ whole rather than guessed at: a multi-episode file sharing its start number with another file (nothing says which comes first), and one that would itself have to move (its range would need rewriting).

Entries come out highest-number-first, because a new number is always at or above the old one and each target has to be vacated before anything moves onto it. This is the one mode that plans a target which currently exists on disk; `validatePlan` allows it only when an **earlier** entry moves that file away, so a genuine clobber — or a swap, which no ordering can save — still aborts the run before the first rename. Undo replays in reverse and applies the mirror of the same rule.

One thing `renumber` cannot know is whether the parts are really two episodes. Where TMDB merges a two-parter into a single entry, renumbering deliberately diverges from TMDB and `validate:shows` will report the season as holding one episode too many. [TheTVDB](https://thetvdb.com) usually numbers the parts separately, so its numbering is generally what a renumbered season matches — worth checking the show there before `--apply`.

A show split into one folder per subject — each with a single `Season 01`, but files still numbered for the season they were in upstream — takes all three file modes in order, then a re-scan:

```bash
npm run fix:shows -- --fix season-code  external --apply   # s06e01 → s01e01
npm run fix:shows -- --fix show-prefix  external --apply   # prefix → the folder's title and year
npm run validate:shows external                            # match each folder to its own TMDB id
npm run fix:shows -- --fix episode-titles external --apply # now the codes line up with TMDB's seasons
```

`season-code` comes first: `episode-titles` looks the season up by the number in the filename, so it finds nothing for a file claiming a season its TMDB entry doesn't have.

`episode-titles` reads `output/<drive>/shows/data/validation.json` and `cache/tmdb-show-seasons.json`, so **run `npm run validate:shows <drive>` first**. It makes no network calls of its own.

### Running it

```bash
npm run fix:shows -- --fix show-prefix external            # 1. preview
npm run fix:shows -- --fix show-prefix external --apply    # 2. execute
npm run shows external                                     # 3. re-scan and confirm
```

Scope a run to one show while you build confidence:

```bash
npm run fix:shows -- --fix episode-titles external --show "Barry (2018)"
```

To reverse a run:

```bash
npm run fix:shows -- --undo output/external/shows/fixes/rename-undo-2026-09-07T21-57-53-887Z.json
```

The manifest is checked in full before anything is renamed. If any entry would move a file or folder to a different parent folder, rename a folder from an entry not marked as one, rename it over a file that now exists, or collide with another entry, the undo is aborted and nothing changes — so a hand-edited or stale manifest can't destroy a file.

### The season guard on `episode-titles`

Episode titles are looked up by **episode number**, so the mapping is only trustworthy while your season and TMDB's agree about which episodes the season contains. If they disagree, the numbering may be offset and every title in that season is suspect — not just the ones that fail to resolve.

So `episode-titles` skips a season entirely unless both hold:

1. **Every file resolves to a TMDB episode.** One file pointing at a number TMDB doesn't list — a recap episode, a web short — means the season carries content TMDB doesn't know about.
2. **The season's files cover exactly as many TMDB episodes as TMDB lists.** Catches seasons that are missing episodes locally.

The guard is all-or-nothing: a skipped season keeps _every_ file untouched, including ones that would have resolved fine. That's deliberate — a partially-named season with one wrong title is worse than an unnamed one.

**`--allow-partial`** relaxes only the second check, for a library that holds part of a season (13 of TMDB's 26 episodes, say). Each file still gets the title TMDB lists for its number, and the first check still skips the whole season if any file's number is missing from TMDB. The count can no longer catch a numbering offset (DVD vs. aired order, a merged two-parter), so every entry from a partial season carries a `partial season — N of M TMDB episodes` note in the dry run. Spot-check those before `--apply`:

```bash
npm run fix:shows -- --fix episode-titles external --allow-partial
```

What's counted is the number of **TMDB episodes resolved**, not local files, which makes multi-episode files come out right in both directions: one file spanning `E01-E02` counts as two episodes, and a file spanning a two-parter that TMDB merged into a single entry counts as one.

Seasons with no cached TMDB data (most `Specials` folders) are skipped for the same reason.

### Illegal characters in titles

TMDB titles routinely contain characters Windows forbids in a filename (`< > : " | ? * \ /`). These are **deleted**, never substituted — the same rule `stripFilenameIllegalChars` applies everywhere else in the codebase:

| TMDB title                   | On disk                     |
| ---------------------------- | --------------------------- |
| `Chapter Two: The Vanishing` | `Chapter Two The Vanishing` |
| `East/West`                  | `EastWest`                  |
| `ronny/lily`                 | `ronnylily`                 |
| `All Good Things...`         | `All Good Things`           |

Trailing periods go too, because Windows silently drops them. Deleting rather than substituting keeps the on-disk name matching TMDB under the validator's strict tier, which deletes the same characters from the other side — so these don't turn into `warn_tmdb_episode_name_mismatch` noise.

### Renaming invalidates the probe cache

The ffprobe cache is keyed on each file's path, so renamed files re-probe on the next scan. That's expected — budget a few minutes after a large batch. Nothing else in the cache is affected.

### Verify against the filesystem, not the success count

After an `--apply`, confirm the result on disk rather than trusting the reported number. A case-only rename (`talespin.mp4` → `TaleSpin.mp4`) is a **silent no-op** through a plain rename on case-insensitive filesystems — exFAT external drives especially. The tool handles this with a two-step rename through a temporary name, but the general habit is worth keeping: this exact failure once reported 726 successful renames while leaving 174 files untouched.
