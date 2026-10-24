# Scans & Validation

The day-to-day guide: how to run MOASYS-Vault, what each pass does, and how long it takes.

| Pass                       | Command                            | What it does                                                                                        |
| -------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Scan](#scan-pass)         | `npm run <type> [drive]`           | Inspects every file and walks your folders. Writes your catalog and a list of hygiene issues.       |
| [Validate](#validate-pass) | `npm run validate:<type> [drive]`  | Cross-checks the catalog against TheMovieDB (movies, shows) or Open Library (audiobooks). Optional. |
| [Plex](PLEX.md)            | `npm run plex:pull` / `plex:check` | Compares what Plex has with what's on disk. Optional.                                               |
| [Report](#merged-report)   | `npm run report [drive]`           | Folds every pass's warnings into one entry per folder. The file you actually work from.             |

Every command takes an optional drive name — a root's `name` from `config.json`. Leave it off and each type uses its first root. Drives are scanned independently and never merged; see [Selecting a drive](CONFIG.md#selecting-a-drive).

---

## Workflow

### First run

```bash
npm install
cp config.example.json config.json   # then edit the paths — see Configuration

npm run all                          # slow once: every file gets inspected (see Speed below)
npm run all external                 # repeat for each extra drive, if you have one
```

If your library is split into category folders (`HD/`, `UHD/`, `Audible/`), set `categories` before the first run — see [Choosing a layout](CONFIG.md#choosing-a-layout). `npm run all` skips whatever isn't set up yet, so the first run is just the scan. Then, optionally, set up the cross-checks:

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

Steps that aren't set up are skipped with the reason — no TMDB key skips movie and show validation (audiobooks still validate), and no `plex` block or token skips both Plex steps. A failing step stops the run. `plex:logs` isn't included.

### Command order

`npm run all` handles the order for you. Running commands individually, each one reads what an earlier one wrote:

| Order | Command                        | Needs first                                                                |
| ----- | ------------------------------ | -------------------------------------------------------------------------- |
| 1     | `npm run scan:all [drive]`     | `config.json`                                                              |
| 2     | `npm run validate:all [drive]` | The scan (reads its catalog); a TMDB key for movies and shows              |
| 3     | `npm run plex:pull`            | Plex `url` in `config.json` and a token in `.secrets.json`                 |
| 4     | `npm run plex:check [drive]`   | The scan and the pull; compares TMDB ids when validation has run           |
| 5     | `npm run report [drive]`       | Nothing — it merges whichever of the above have run, and names the rest    |
| 6     | `npm run plex:logs [drive]`    | The pull; the server owner's token. Occasional — not part of `npm run all` |

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

**The cache.** `cache/<drive>/<type>-probe.json` is keyed by `path | modification time | size`, with the path relative to the drive's `root_path`, so replacing, re-tagging, or moving a file re-inspects it. A rename that only changes capitalization keeps its entry. Entries for files that are gone, or that changed since, are dropped at the end of each scan, and the cache is saved straight after the inspection step, so an error later in the run doesn't lose a long first scan. Each drive keeps its own file — a shared one would let one drive's cleanup delete the other's entries. Delete the file to force a full re-inspection.

**Stuck files.** One file is given two minutes to inspect. A file that takes longer (a stalled network share, a damaged file) is reported as `warn_probe_failed` and the scan moves on.

### Quality buckets (movies and shows)

If your library is organized by quality (folders like `UHD/`, `HD/`, `SD/` — see [Quality folders](CONFIG.md#quality-folders-uhd-hd-sd) for setting them up), you can tell the scanner what those names mean in terms of pixel dimensions:

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

Each bucket's `name` is one of the quality keywords — `UHD`, `HD`, or `SD`. Two things happen for every video file:

1. **Quality derivation** — the bucket whose width range contains the file's long edge becomes the version's `quality`, whichever folder the file is in.
2. **`warn_quality_mismatch`** — when the file's folder has a quality (`Other HD/` is HD; `Documentary/` has none) and the file's long edge doesn't fit that bucket.

So a 480p file in `Other HD/` is flagged, and a 480p file in `Documentary/` isn't. The checks go by the long edge, so HandBrake-cropped 664×448 SD and 1920×800 HD both classify correctly. `quality_thresholds` ships empty, so a library that isn't organized by quality stays quiet.

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
- `output/<drive>/<type>/data/validation.json` — per-record TMDB resolution (canonical title, year, TMDB ID, alternatives), read by `plex:check`

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
- **Episode title mismatches** — each episode file's trailing `- Episode Title` is compared against TMDB's episode title for that S/E number, using the same strict-then-loose two-tier comparison described below. The loose tier matters here: Windows silently drops trailing periods, so `All Good Things...` and `T.R.A.C.K.S.` _cannot_ exist on disk in canonical form, and a strict-only comparison would flag them forever. Multi-episode files (`S01E01-E02`) are skipped by default because their combined titles rarely match strictly; enable `warn_tmdb_episode_name_multi_episode` if you want them checked too. A show's uncached seasons are fetched together, up to 20 per request, and cached in `cache/tmdb-show-seasons.json`.

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

Movies have one override: an exact-year match loses to a film with the same title one year off when that film has at least 1,000 TMDB votes and 100 times as many as the exact-year one. `Enemy (2013)` is Villeneuve's film, which TMDB dates 2014 with ~6,600 votes, not the Tamil `Enemy` from 2013 with 8. The famous film keeps its own off-by-one score, so it comes out **medium**, never **high**.

#### ID tags on show folders

A `{tmdb-N}` tag settles the match outright: the search is skipped and the show is looked up by that ID, at `high` confidence.

A `{tvdb-N}` tag says the folder follows TVDB's season and episode layout, which TMDB often doesn't share. TMDB lists the `Monster` anthology as separate shows, and orders The Muppet Show's guests differently. So `validate:shows` doesn't compare a TVDB-ordered folder against TMDB's episodes:

- **`{tvdb-N}` alone:** the show isn't searched for at all, since a title search lands on the wrong series (`Monster` → _Monster High_). The row records `tmdb_id: null` and `confidence: "none"`, and no `warn_tmdb_no_match` fires — the tag already identifies the show. With no TMDB ID, `plex:check` leaves it alone too.
- **`{tmdb-N}` and `{tvdb-N}`:** the TMDB ID still pins the series, so `warn_tmdb_title_canonical` runs. `warn_tmdb_episode_count` and `warn_tmdb_episode_name_mismatch` don't, and `tmdb_episode_count` stays `null`.

### Caching

Four caches keep TMDB calls minimal:

- `cache/tmdb-search.json` — search-query to resolved-match lookup
- `cache/tmdb-movies.json` — full movie records by TMDB ID
- `cache/tmdb-shows.json` — full show records by TMDB ID
- `cache/tmdb-show-seasons.json` — per-season episode details (titles, air dates), only populated when `warn_tmdb_episode_name_mismatch` is enabled

Unlike the file-inspection cache, these are **not** split per drive — they're keyed by title and year rather than by path, so validating a second drive reuses everything the first one fetched.

**Credits and keywords.** Movie and show records also carry the top 20 billed cast, the directors and writers (including the novel or comic a title is based on), and TMDB's keywords. No check reads them; they're kept so questions like "which of my movies star Steve Martin?" or "which are Christmas movies?" can be answered from the cache without going back to TMDB. They come back with the same request as the rest of the record, so they cost nothing extra. A record cached before 0.23 doesn't have them, so the first `validate:movies` and `validate:shows` after upgrading fetch each matched title once more — about one request per title, roughly 10–20 minutes for a library of a few thousand movies. The caches are saved when the run ends, including when it stops on an error, but not if you press Ctrl+C.

All gitignored. Total first-run cost for the example library: ~10 min for movies, ~3 min for shows.

#### Negative results are re-checked weekly

**High** and **medium** matches are served from the cache until you [refresh them](#refreshing-stale-entries). A **none** or **low** verdict is asked again once it's a week old.

TMDB's search index changes over time, and a title it couldn't find last month may be findable today. `Face/Off` is the worked example — the folder must be named `FaceOff` because `/` is illegal in a filename, and for months TMDB returned nothing for that query. It returns the film now. Never re-asking would have kept that false `warn_tmdb_no_match` forever; re-asking every run cost a few hundred requests per run for the same answer. Once a week is the middle ground.

#### Refreshing stale entries

Every cache entry is timestamped at fetch time. By default, no entry ever expires — the cache file grows until you delete it. TMDB metadata does change occasionally (year corrections, added seasons, episode title fixes), so you may want to re-fetch entries older than some threshold:

```bash
# Re-fetch any TMDB record fetched more than 30 days ago
npm run validate:movies -- --refresh-older-than=30d
npm run validate:shows -- --refresh-older-than=30d
```

The flag accepts a number of days with optional `d` suffix (`30` and `30d` are equivalent). Without it, every cached entry is used regardless of age. A sensible cadence is once a month or so — the rate limiter throttles re-fetches the same way as fresh ones, so a full refresh is the same wall-clock cost as your first run.

### Rate limiting and outages

Requests are spaced to 4 per second, so no tuning is needed. A `429 Too Many Requests` is retried after the wait TMDB asks for.

A network error, timeout, or TMDB server error is retried twice, after 2 and 4 seconds. If it still fails, that title keeps its result from the last run; a title that has never been checked is left out until next time. It is **never** recorded as "no match", so an outage can't fill your warnings with false `warn_tmdb_no_match` rows or wipe the TMDB ids `plex:check` relies on.

Two failures stop validation instead:

- **The API key is rejected** (HTTP 401). Check `tmdb.api_key` in `.secrets.json`.
- **Five requests fail in a row**, which means TMDB or your connection is down.

Either way nothing is written for the type in progress, so its previous `validation-warnings.json` and `data/validation.json` stand. Under `validate:all` the other TMDB type is skipped too, and audiobooks still run.

### Audiobooks against Open Library

```bash
npm run validate:audiobooks
```

No key and no setup. Each book is searched on [Open Library](https://openlibrary.org/) by title and first author, falling back to the title alone (which is what catches a misspelled author folder) and then to the title's first segment. Series segments (`Gaunt's Ghosts, Book 2`, `Book Two in the Dune Chronicles`) and all-parenthetical edition segments are dropped before searching.

Open Library is community-edited and inconsistent: one book appears as several editions titled `The Flood (Halo)`, `Halo` with subtitle `the flood`, `Star Wars - Thrawn Trilogy - Dark Force Rising`. So the folder title is compared against **every** result, and one matching edition is enough. Case, punctuation, a colon where the folder has a dash, a franchise prefix Open Library leaves off, and series text Open Library pads in are all ignored. What's left to warn about:

- **`warn_openlibrary_title_mismatch`** — nothing matches, but a book by the same author is within a couple of characters. The shape of a typo; the message gives Open Library's spelling.
- **`warn_openlibrary_author_mismatch`** — the title matches but none of your folder's authors do. Usually an author-folder typo, occasionally a different book with the same title. **Off by default**: the scan already compares each author folder against its sibling folders (`warn_author_name_mismatch`) and against the embedded artist tag (`warn_author_tag_mismatch`), so one typo produced three findings for one rename — and Open Library credits narrators, translators and editors as authors.
- **`warn_openlibrary_title_case`** and **`warn_openlibrary_not_found`** — both **off by default**. Open Library's capitalization is unreliable, and translated books are often listed only under their original title (the Witcher novels appear as `Krew elfów` and friends), so these are mostly noise. Turn them on in `rules/audiobooks.local.yaml` for a one-off audit.

Results are cached in `cache/openlibrary-search.json`, shared across drives. Like the TMDB pass, an empty result is asked again once it's a week old, so a book Open Library adds later is found. A search that fails (network, server error) leaves that book out of the run rather than reporting it as missing. `--refresh-older-than=Nd` works the same way. Requests are held to one per second as Open Library asks; a first run over ~110 books takes about two minutes, and warm runs make no requests.

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
