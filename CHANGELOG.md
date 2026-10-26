# Changelog

What's landed, newest first. Not formal release notes — pointers to what's new if you're returning after time away. Entries marked _(breaking)_ change a file format or setting you may need to update.

## v0.24

- **New `npm run collections <library>` — apply a collection review to Plex.** It reads `output/plex/<library>/collection-review.md`, with sections `# Create`, `# Add` and `# Remove`, each holding `## Collection` headings and `- Title (Year)` lines. It then creates those collections and adds or removes their items. It's a dry run unless you add `--apply`. Everything is checked live against Plex before anything changes: a line matching nothing or more than one title, a Create for a name that exists (or nearly does, like `The X-Files` beside `The X Files`), or an Add for a collection that doesn't exist stops the run with nothing touched. A journal is written before the first change, `--undo <journal>` reverses a run, finished lines come out of the review file, and the library is pulled again afterwards. See [the collections command](docs/PLEX.md#npm-run-collections-library).
- **The first command that changes Plex — and only collections.** Collections live in Plex's database, not your media files, so this sits outside the never-touch-media rule. It's held to collections in code: every request passes one check that allows only creating a collection, adding items to one, and taking one item out, with every id checked against the library you named. Nothing can refresh a library, edit metadata, delete a collection, or reach a file. The read-only client the other Plex commands use is unchanged. See [Safeguards](docs/PLEX.md#safeguards).

## v0.23

- _(breaking)_ **`fix:shows` is gone — nothing writes to a media library any more.** The renaming tool was the one exception to the read-only rule; it's been removed with its npm script, docs, and `output/<drive>/shows/fixes/` folder. Every warning it used to fix is still reported, with the remedy in [the warning tables](docs/OUTPUT.md#warning-tables). A leftover `fixes/` folder is pointed out when a command runs; to replay an old `rename-undo-*.json`, check out commit `8e7515a`. On top of that, every file the app writes now goes through one function that refuses any path outside the project folder.
- **Scans list each folder once.** The inspection step and the scan step walked the same folders separately; they now share one listing. A warm `npm run shows` on the Server drive went from 21 s to 15 s. Probe progress prints about ten lines rather than one per 100 files.
- **The probe cache stops growing.** A re-tagged or replaced file left its old entry behind forever, and a capitalization-only rename was inspected again from scratch. Old entries are now dropped (347 on the Server shows cache), a case-only rename keeps its entry, and the cache is saved right after inspection so an error later in the scan can't lose a long first run. One file can no longer hang the run: ffprobe gets two minutes, then the file is reported as `warn_probe_failed`.
- **New `warn_unlisted_folder`.** A folder under `root_path` that isn't in `categories` was silently skipped — its contents never scanned or warned about. It's now named. In a library with no categories, a top-level folder called `HD` or `Other UHD` gets the same warning, since it usually means `categories` needs setting. See [Choosing a layout](docs/CONFIG.md#choosing-a-layout), a new guide to flat, categorized, and shared-folder setups, with a `rules/<type>.local.yaml.example` per type.
- **A TMDB outage no longer wipes your validation results.** A failed search was recorded as "no match", so going offline (or an expired key) produced a `warn_tmdb_no_match` for every title and overwrote the TMDB ids `plex:check` uses. Network and server errors are now retried; a title that still fails keeps last run's result, or is left out if it never had one. A rejected key, or five failures in a row, stops validation without writing anything. No-match and low-confidence verdicts are re-checked weekly rather than every run (a few hundred requests saved per run). Open Library requests time out after 30 s, and a book whose search fails is no longer reported as not found. See [Rate limiting and outages](docs/SCANS.md#rate-limiting-and-outages).
- **Audiobooks with the same title by different authors stay separate.** Books were keyed by title alone, so two authors' `Collected Stories` merged into one catalog entry and could raise a false `warn_duplicate_book`. They're now keyed by author folder and title. Author folders joined with `&` (`Douglas Preston & Lincoln Child`) are split into names the same way the artist tag is, which ends a false `warn_author_tag_mismatch`. `audiobooks.json` gains `author_folder`, the folder as named on disk, and warning paths use it.
- **Fixes to which warnings appear and where:**
  - Movies' `warn_multi_quality` and `warn_duplicate_quality` use the folder name, `{tmdb-N}` tag and all, so a `movies:` ignore entry for the folder reaches them. Validation rows for a tagged movie folder now group with its scan rows.
  - `warn_bad_folder_name` appears once per folder, including folders where no file parses.
  - Validation rows for a movie edition kept as a file in a shared folder (`The Hobbit (2014)/… {edition-M4 Book Edit}.mp4`) are filed under that real folder and start with the edition's name. They used to sit under a folder that doesn't exist (`The Hobbit (2014) {edition-M4 Book Edit}`), splitting one movie into several report entries and needing an ignore entry per edition. `movies.json` gains `folder`, the folder as named on disk.
  - A file whose name doesn't parse no longer adds a version to `shows.json`.
  - `probe.json` lists episodes `S01E99` before `S01E100`.
  - WAV and AIFF tracks are summarized as lossless (`PCM 16/44.1`).
  - Music `warn_missing_tags` and `warn_track_number_mismatch` list file names rather than full paths.
  - Music `warn_quality_inconsistent` folds a wide VBR spread into a range (`MP3 196–280 (29 bitrates)`) instead of listing every rate.
  - The duplicate checks read `Copies in 2 categories: Music, Soundtracks.` (they said "Also in 2 other categories" while counting the item's own).
  - A permission error on a category folder is reported as `permission_denied` instead of crashing the scan.
  - In a library with no categories, warnings about the top folder have the path `.` and can be silenced with `folders: ['.']`.
- **Low-confidence TMDB warnings name the alternatives.** The other likely matches were listed only when their full details happened to be cached, which they almost never were, so `alternatives` was nearly always empty. Each search now keeps the top five results' titles and years, at no extra request. Older cache entries hold bare ids; they're replaced the next time their verdict is re-checked (within a week), so no cache reset is needed.
- **The TMDB cache keeps cast, crew, and keywords.** Movie and show records now hold the top 20 billed cast, directors and writers, and TMDB's keywords, fetched with the same request as the rest of the record. Nothing checks them yet; they're there so collection questions ("which of my movies are Christmas movies, or star Chevy Chase?") can be answered from the cache. Records cached earlier are fetched once more on the next `validate:movies` / `validate:shows` (about 10–20 minutes on the Server drive); nothing is discarded. See [Caching](docs/SCANS.md#caching).
- **`validate:shows` fetches a show's seasons together.** Episode-title checks fetched TMDB's episode list one season at a time. A show's uncached seasons now come up to 20 per request — tested live: 25 seasons of _The Simpsons_ in 2 requests rather than 25. This mainly speeds up a first run or a `--refresh-older-than` run.
- _(breaking for `probe.json` readers)_ **In `data/probe.json`, each file's `quality` is now `category`.** It always held the category folder (`Other HD`, `Audible`), while `quality` in the catalogs means the resolution or codec; one word for two things. Nothing in the app reads it, and `probe.json` is documented as internal, but a script of your own that does needs updating. The next scan rewrites the files.
- **The output schemas are tested.** A new test builds every output file from small fixtures with the real code and validates it against its schema in `schemas/`, so a shape change that misses its schema fails `npm test`. It adds `ajv` as a dev dependency.
- **`plex:pull` is about twice as fast.** Fetching each collection's contents was most of a pull's requests, one at a time; four now run at once. On the Server: 110 s to 53 s, with identical output.
- **Plex mapping handles more setups.** When one folder could belong to roots of different media types, the Plex library's type now decides. A root at the top of a drive (`D:\`) is reported as unmapped rather than mismatched. `plex:logs` reads a Windows-hosted server's `E:\…` paths. `plex:check` and `plex:logs` show each library's own pull time, so a partial `plex:pull` no longer makes old catalogs look fresh.
- _(breaking)_ **Stricter settings and arguments.**
  - The rules files reject regex flags `g` and `y`, which made reused patterns skip every other name.
  - They also reject a category listed twice and a category named `default`.
  - Every command rejects an unknown flag or a second drive name instead of ignoring it, so `--no-ignor` is an error rather than a silently filtered run.
  - `--refresh-older-than 30` (with a space) works like `=30`.

- **Three new music checks.** `warn_duplicate_track` flags two files in one album with the same disc and track number, such as a leftover `18 - Holliday - Copy.flac`. `warn_garbled_name` flags artist, album and track names with mis-encoded characters (`Thereâ€™s` for `There’s`) and gives the repaired spelling; real accents like `Pâté` are left alone. `warn_missing_duration` flags tracks whose header records no length, which players may show as 0:00. On the Server drive they found one duplicate, two garbled Witcher 3 names and 11 Halo bonus-track FLACs. Each has a toggle in `rules/music.yaml`. See [the music warning table](docs/OUTPUT.md#music).
- **`validate:movies` prefers a famous film one year off over an obscure namesake.** `Enemy (2013)` matched a Tamil film with 8 TMDB votes at `high` confidence, because Villeneuve's _Enemy_ is dated 2014 on TMDB and the exact year always won. A same-title film one year off now wins when it has at least 1,000 votes and 100 times as many, at `medium` confidence. The TMDB search cache moves to version 5, so the first `validate` run re-searches every title (about 20 minutes on the Server drive). See [How matching works](docs/SCANS.md#how-matching-works).
- **`plex:logs` names transcode failures.** A `Failed to transcode file` line was reported as the generic _Plex logged a problem_, so Star City S01E03 on the Server drive looked like noise, though its audio and video are corrupt. It now reads _Plex failed to transcode the file_, with advice to play it through and replace it. See [the problems table](docs/PLEX.md#log-warnings).
- **`npm run report -- --type shows` works.** The `report` script always passes `--all`, so `--type` was ignored and the type name was read as the drive (`no root named 'shows'`). An explicit `--type` now narrows a leading `--all`, for every runner.
- **A `Specials` ignore entry reaches the shows quality checks.** `warn_multi_quality` and `warn_duplicate_quality` labelled a named season folder `Season Specials`, which no `seasons:` entry could match, so Saturday Night Live's specials couldn't be silenced. Named seasons now keep their folder name (`Show (2020) — Specials`).

## v0.21

- **Node 24 is now the minimum.** `engines` and the README require Node 24 (it was 22.12), matching what CI already ran. CI's `actions/checkout` and `actions/setup-node` move from v4 to v7, which run on Node 24 themselves, clearing GitHub's Node 20 deprecation warning. `music-metadata` moves to 11.16.1 for two security fixes (a malformed file could hang the tag reader or exhaust memory), alongside patch updates to vitest, tsx and zod.
- **Split episodes are catalogued as one episode.** Plex plays `s02e05 - The Rise of Scar Part 1` and `Part 2` as one episode, but `shows.json` kept only the first file, marker and all, and counted both. So `validate:shows` compared `The Rise of Scar Part 1` against TMDB's `The Rise of Scar` and could never match. Where several files share an episode code and differ only by a part marker (`pt`, `part`, `cd`, `disc`, `disk`, `dvd` plus a number — the set `warn_duplicate_episode` already stacks on), the entry is now titled without the marker and counted once. A `Part 1` with a code of its own, like `s06e15 - The Finale Part 1`, is a real title and is kept whole. See [Reading a split episode](docs/OUTPUT.md#showsjson).
- **`plex:logs` no longer blames multi-part credits errors on the wrong episode.** Plex logs `Detection is unsupported with multi-part media items` without naming the item, right after the previous episode's `Completed credits detection` line, so the error was tied to that episode, which had just succeeded. On the Server drive this flagged Lion Guard S02E04 and Three's Company S01E06, both single files. A thread's context now ends when that item completes, and these errors stay untied in `logs-summary.json`. See [How problems are tied to files](docs/PLEX.md#how-problems-are-tied-to-files).
- **`validate:shows` reports seasons you don't have at all.** `warn_tmdb_episode_count` only compares the seasons you have, so a series missing its last three seasons looked complete. The new `warn_tmdb_missing_seasons` lists aired TMDB seasons with no folder, one row per show. It leaves out season 0, empty seasons and seasons not yet aired, and pools seasons across folders matched to the same TMDB id. The list is also written to `validation.json` as `missing_seasons`. On the Server drive it found 48 shows. See [the shows warning table](docs/OUTPUT.md#shows).
- **Large files are flagged by bitrate.** Each `quality_thresholds` bucket takes an optional `max_mbps` ceiling (size ÷ runtime), and a movie or episode over the ceiling for the quality its dimensions fit fires `warn_large_file`. Shows get one row per season, largest episodes first. No ceilings ship by default, so nothing changes until you set some. See [`quality_thresholds`](docs/CONFIG.md#quality_thresholds).
- **Season-0 folders get a house style.** The new `specials_folder` setting (`specials`, `season00` or `any`, the default) drives `warn_specials_folder_style`. `warn_duplicate_season_folder` catches a show with two folders Plex reads as one season, such as `Season 00` beside `Specials`. Files in a `Specials` folder are now expected to carry `s00` codes, as in `Season 00`. `validate:shows` now checks their titles against TMDB's season 0, where it used to skip `Specials` while checking `Season 00`. See [`specials_folder`](docs/CONFIG.md#specials_folder).

## v0.20

- **`validate:shows` no longer compares a `{tvdb-N}` folder against TMDB's episodes.** The tag means the folder follows TVDB's season layout, but validation searched TMDB by title anyway: `Monster (2022) {tvdb-389492}` matched _Monster High_ and The Muppet Show's guests were checked against TMDB's order. On the Server drive, 154 of 155 validation warnings were this noise. Worse, `validation.json` recorded the wrong TMDB ID, which `fix:shows --fix episode-titles` would have used to name Monster's files after _Monster High_ episodes. A folder tagged `{tvdb-N}` alone is no longer searched, gets `tmdb_id: null`, and fires no `warn_tmdb_no_match`. With `{tmdb-N}` as well, the title check still runs but the episode count and title checks don't, and `episode-titles` skips the show. See [ID tags on show folders](docs/SCANS.md#id-tags-on-show-folders).
- **`episodes:` ignore entries work again on the checks that summarize a season.** Shows `warn_quality_mismatch` became one row per season in v0.14, and an entry naming an episode can't match a row about the season above it — so every entry written for the old per-episode rows silently stopped working. Those checks, along with `warn_missing_episode_title`, `warn_episode_code_case`, `warn_duplicate_episode`, `warn_episode_gaps` and the `plex:logs` warnings, now leave an ignored episode out of the summary, and drop the row once none are left. A gap has no file, so name its code: `Lost (2004)/S02E21`. See [Scope](docs/CONFIG.md#scope).

## v0.19

- **Movie names accept Plex's `{tmdb-N}` ID tag** on the folder, the file, or both — `The Animatrix (2003) {tmdb-55931}` no longer fires `warn_bad_folder_name`. With an edition, the tag goes last: `Blade Runner (1982) {edition-Final Cut} {tmdb-78}`. `movies.json` gains a `tmdb_id` field, `validate:movies` looks a tagged movie up by that ID instead of searching by title, and the new `warn_tmdb_tag_mismatch` flags a folder and file that pin different IDs. See [CONVENTIONS.md](docs/CONVENTIONS.md#movies).
- **Show folders accept `{tmdb-N}` too**, last on the folder: `Icons Unearthed The Simpsons (2022) {tmdb-214176}`. It pins the match for Plex and `validate:shows` when a similarly named series keeps winning. `shows.json` gains `tmdb_id`, `validation.json` rows gain `tmdb_tag`, and warning paths keep the tag so they match the folder on disk. Episode files keep their plain prefix.
- **Show folders accept `{tvdb-N}`** for anthologies TVDB treats as one series with a season per story, which Plex's TV agent follows: `Monster (2022) {tvdb-389492}` holding Dahmer as Season 01 and Menendez as Season 02. Kept as separate folders, Plex merged them episode by episode. `shows.json` gains `tvdb_id`; validation stays TMDB-based and ignores it. See [CONVENTIONS.md](docs/CONVENTIONS.md#shows).
- **New `warn_duplicate_episode`** flags a season folder where two files cover the same episode — an exact copy under a second name, or a two-parter overlapping a single file. Plex silently merges them, so until now they surfaced only as `warn_plex_duplicate` after a Plex check.
- **`fix:shows --fix episode-titles --split-episode S05E01`** names a season where you hold a two-parter as two files but TMDB lists it as one `A / B` entry (This Is Us S5: TMDB has `Forty (1) / Forty (2)` at E01 and nothing at E02). The season guard skipped such a season because E02 isn't in TMDB. The flag splits the entry over E01 and E02 and, if TMDB numbered straight on instead of leaving a gap, moves every later TMDB episode up one. It requires `--show`, skips the season if the entry isn't exactly two titles, and notes every entry the split changed. See [The season guard](https://github.com/SergeantMossimo/MOASYS-Vault/blob/8e7515a/docs/SCANS.md#the-season-guard-on-episode-titles).
- **`plex:logs` skips lines about files the last scan doesn't have.** Plex keeps a day or two of logs, so a show moved out of the library kept reporting its old errors in `plex-log-warnings.json` until those logs rotated away. The run prints how many lines it skipped. See [How problems are tied to files](docs/PLEX.md#how-problems-are-tied-to-files).

## v0.18

- _(breaking)_ **Warnings are grouped by folder, not by warning type.** Every warnings file is now `{ generated, count, folder_count, by_type, folders }`, where each entry in `folders` is one show, movie, artist, or author with every finding on it — because that's the unit you work in. A row's `path` is relative to its folder (`Season 09`, not `SD/Good Eats (1999)/Season 09`) and absent entirely when the warning is about the folder itself. On one real drive, 429 rows scattered across three type buckets became 155 folder entries. See [`warnings.json`](docs/OUTPUT.md#warningsjson-shape-shared-across-scan--validate--plex).
- **`npm run report` writes `all-warnings.json`** — the four per-command warnings files folded into one entry per folder, with each row tagged by the `command` that found it. A show flagged by both the scan and the TMDB pass was previously two files to join by hand; on the same drive, 56 of 155 shows appeared in both. It reads only `output/`, never your library, so it works with the drive unplugged, and its `sources` block reports a command that has never run as `"count": null` rather than `0` — a partial report can't look like a clean library. Runs last in `npm run all`, which gained `--no-report`. See [Merged report](docs/SCANS.md#merged-report).
- **`fix:shows --fix season-code`** rewrites each file's season number to the one its `Season NN` folder names (`s06e01` → `s01e01`), leaving the episode number and the code's casing byte-for-byte alone. It fixes `warn_season_mismatch` in one direction only — folder right, code wrong — because the other reading needs the file moved to a different folder, which this tool never does. A `Specials` folder has no number to align to and is skipped; a folder the rules reject (`Season  01`) goes to review, since renaming the folder is the fix there. Where one season folder holds files from several seasons, every planned entry says so. This unblocks `episode-titles` for a show split into one folder per subject, whose files still carry their upstream season — that mode looks the season up by the number in the filename, so it found nothing for them before. See [Modes](https://github.com/SergeantMossimo/MOASYS-Vault/blob/8e7515a/docs/SCANS.md#modes).
- **`fix:shows --fix renumber`** gives each file its own episode number where a two-parter was split into two files sharing one code (`s03e18 - Camdenites Part 1` and `Part 2`). Plex matches on the episode number, so it read those as two _versions_ of one episode rather than two episodes, and the second was awkward to reach. Parts take consecutive numbers in filename order and everything below shifts up by as many extra parts as appeared above it. **Gaps are preserved** — the new number is the old one plus an offset, never a re-sequence from 1, because a gap means a missing episode and closing it would renumber the season around a file you still mean to add. A file that reuses a number a multi-episode file covers (`s04e01-e02` then `s04e02`, a two-part premiere held as one file) shifts past the range the same way, flagged for review; a multi-episode file that shares its start with another file, or would itself have to move, is skipped whole rather than guessed at. Where TMDB merges a two-parter into one entry, a renumbered season deliberately diverges from TMDB and matches [TheTVDB](https://thetvdb.com)'s numbering instead. See [`renumber`](https://github.com/SergeantMossimo/MOASYS-Vault/blob/8e7515a/docs/SCANS.md#renumber--two-files-one-episode-number).
- **`fix:shows --fix trailing-separator`** trims separator debris off a filename that parses once it is gone — `Hercules (1998) - s01e12 -.mp4` → `Hercules (1998) - s01e12.mp4`, the shape left when an episode title is deleted but the `-` that introduced it is not. Such a name matches neither `patterns.file` nor the lenient fallback, which made the file invisible to every other mode rather than merely skipped: a name has to parse before anything can rewrite one part of it. The rule is self-verifying — trim trailing whitespace and hyphens, rename only if the result matches `patterns.file` — so the new name is always a prefix of the old one and nothing is ever inferred. A name that still fails to parse once trimmed, or one that parses _with_ the debris (the title group is greedy), is reported and left alone. See [`trailing-separator`](https://github.com/SergeantMossimo/MOASYS-Vault/blob/8e7515a/docs/SCANS.md#trailing-separator--a-name-nothing-else-can-see).
- `validatePlan` and `validateUndoManifest` now tell a **chained** rename apart from a clobber. A cascade plans targets that currently exist on disk, which every earlier mode would have aborted on; a target is accepted only when an earlier entry vacates it (and on undo, which replays in reverse, only when a later entry does). A plain overwrite, or a swap — which no ordering can make safe — still aborts the whole run before the first rename.
- _(breaking)_ The recommended fix and the ready-to-paste `ignore` entry are no longer written to the warnings files. Both were identical on every row of a warning type, which is exactly what buried the facts that differ. The remedy now lives only in the [warning tables](docs/OUTPUT.md#warning-tables); for silencing, the last segment of a folder entry's `path` is the string an ignore list wants.
- _(breaking)_ A folder entry is down to `{path, count, rows}`. `name`, `category` and `types` are gone: the first two are the last and first segments of `path`, and the third is one pass over `rows`, so all three only restated what was already there. They cost 13–18% of every warnings file — the largest went from 116 KB to 96 KB, and `all-warnings.json` from 160 KB to 137 KB, without losing a fact. Applies to all five files. Net effect of the v0.18 changes together: smaller than v0.17 for 2.8× fewer places to look.
- Seasons sort canonically within a folder, so the scan's `Season 03` sits directly beside the TMDB pass's `Season 3` instead of a screen apart. Findings are never deduplicated — `warn_episode_gaps` says which episodes are missing and `warn_tmdb_episode_count` says how many TMDB expects, and both are worth acting on.
- `warn_duplicate_quality` no longer orders its rows UHD-first; that ordering only existed inside a type bucket, and the quality is already the first thing its `issue` says.
- `warn_plex_duplicate` now respects `acceptable_quality_combos`. Plex lists any multi-file item under Duplicates, including the deliberate UHD-plus-HD pairing that is the _default_ whitelisted combo — so `plex:check` was flagging exactly what the scan had been told to ignore. Two copies inside one quality tier are still reported, matching the split the scan makes between `warn_multi_quality` and `warn_duplicate_quality`.
- `warn_openlibrary_author_mismatch` is **off by default**. The scan already compares each author folder against its sibling folders and against the embedded artist tag, so a single mistyped author produced three findings for one rename — and Open Library, unlike those two, credits narrators and translators as authors. Turn it back on in `rules/audiobooks.local.yaml`.

## v0.17

- _(breaking)_ Shows support Plex's [TV Show Editions](docs/CONVENTIONS.md#shows). A show folder may carry a `{edition-Name}` tag after the year (`Spider-Noir (2026) {edition-True Hue Color}`), and each edition is its own catalog entry with its own seasons — matching how Plex tracks them as separate items with separate watch state. `shows.json` and shows `validation.json` gained an `edition` field; `output/<drive>/shows/data/probe.json` did too. Two editions of one season are no longer reported as duplicate copies of each other.
- `warn_empty_edition` (shows) flags a folder tagged `{edition-}` with no name after the dash. A bracketed suffix such as `[True Hue Color]` is deliberately still `warn_bad_show_folder` — Plex does not read it as an edition.
- `fix:shows --fix show-prefix` rebuilds each file's prefix from its folder's parsed title and year rather than the folder name, so an edition tag stays on the folder and off the episode files.
- `plex:pull` records each item's `edition_title`, and `plex:check` gained `warn_plex_edition_mismatch` and `warn_plex_edition_case` comparing it with the folder's tag. Shows only for now: a movie's edition tag is in its filename, so its folder has nothing to compare against.

## v0.16

- _(breaking)_ Warnings files are much shorter. Each `by_type` bucket is now `{ fix, items }`: the recommended fix is written once for the bucket instead of on every row, and each item's `issue` states only what is wrong there. Median issue length went from 264 characters to about 120 — see [`warnings.json`](docs/OUTPUT.md#warningsjson-shape-shared-across-scan--validate--plex).
- Every warning message was rewritten to lead with names and numbers. Missing episodes, tracks and chapters collapse into ranges (`E02–E20, E22`) and stop after eight, instead of listing every one — a single row once reached 3,600 characters.
- `plex-log-warnings.json` rows name up to three problems and drop the per-folder advice and sample log line. The advice is in the [log problem table](docs/PLEX.md#log-warnings), now keyed by the name the warning uses, and the samples are in `logs-summary.json`.
- The warning tables in [Output](docs/OUTPUT.md#warning-tables) are keyed by `warn_*` identifier, matching the Plex tables.
- `fix:shows --fix episode-titles --allow-partial` names seasons you hold only part of. Each entry is marked for review in the dry run — see [the season guard](https://github.com/SergeantMossimo/MOASYS-Vault/blob/8e7515a/docs/SCANS.md#the-season-guard-on-episode-titles).
- `warn_tmdb_episode_name_mismatch` no longer flags titles that are correct once an illegal character and a trailing period are both dropped (`Chevy Chase/Sheila E.` → `Chevy ChaseSheila E`, `7:00 A.M.` → `700 A.M`).

## v0.15

- `fix:shows --fix show-folder` renames one show folder you name with `--show` and `--to`, for when the folder rather than its files is wrong. The dry run shows the TMDB title and the files' prefix as hints — see [Fixing filenames](https://github.com/SergeantMossimo/MOASYS-Vault/blob/8e7515a/docs/SCANS.md#fixing-filenames--npm-run-fixshows).
- Show episode files with 3-digit episode numbers (`S00E201`) are now valid instead of `warn_bad_file_name`.
- `fix:shows --fix episode-code` also zero-pads unpadded numbers (`s02e4` → `s02e04`), and `warn_bad_file_name` points at it for those files.

## v0.14

- Every warning row carries an `ignore` field with the narrowest ready-to-paste ignore-list entry that silences it — see [Silencing a row](docs/CONFIG.md#ignoreddrivetypeyaml--silencing-specific-warnings).
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
