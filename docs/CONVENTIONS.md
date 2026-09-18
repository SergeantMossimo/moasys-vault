# Folder Structure & Naming Conventions

MOASYS-Vault follows Plex's documented folder and file naming conventions. This page is the reference for what your library should look like, with the gotchas that trip people up. For every warning the scanner raises when a library doesn't match, see the [warning tables](OUTPUT.md#warning-tables).

If you already follow Plex's conventions, you're good — the defaults in `rules/<type>.yaml` match Plex. To tighten or loosen anything for your library, see [Configuration](CONFIG.md).

> **Plex's official docs** (for reference):
> [Naming Movie Files](https://support.plex.tv/articles/200381023-naming-movie-files/) ·
> [Naming TV Show Files](https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/) ·
> [Adding Music Media from Folders](https://support.plex.tv/articles/200265296-adding-music-media-from-folders/)

---

## Movies

**Folder layout:**

```text
<Movies>/
└── <Movie Title (YEAR)>/
    ├── <Movie Title (YEAR)>.<ext>
    └── <Movie Title (YEAR)> {edition-<Edition Name>}.<ext>
```

**Naming rules:**

- **Movie folder:** `Movie Title (YEAR)` — the year goes in parentheses
- **File name:** matches the folder name
- **Optional edition tag:** `{edition-<Name>}` between the year and the extension (e.g. `{edition-Director's Cut}`)

**Examples:**

```text
Movies/
├── The Crow (1994)/
│   └── The Crow (1994).mp4
└── Close Encounters of the Third Kind (1977)/
    ├── Close Encounters of the Third Kind (1977).mp4
    ├── Close Encounters of the Third Kind (1977) {edition-Director's Cut}.mp4
    └── Close Encounters of the Third Kind (1977) {edition-Special Edition}.mp4
```

**Gotchas:**

- **Each edition is its own catalog entry.** Two files in one folder claiming the same `{edition-…}` are flagged.
- **Capitalization counts.** A file titled `The crow (1994)` in `The Crow (1994)/` gets its own lower-severity capitalization warning, separate from a genuinely different title.
- **No subfolders inside a movie folder.** The scanner only reads a movie folder's direct children — video files in a subfolder are **not** added to the catalog. The subfolder is flagged so you know what was skipped.
- **Quality folders.** If your categories are organized by quality (`UHD/`, `HD/`, `SD/`), the same movie in two tiers is flagged unless you whitelist the pair, and two copies in the _same_ tier (`HD/` + `Other HD/`) always are. See [Three configuration shapes](CONFIG.md#three-configuration-shapes).

---

## Shows

**Folder layout:**

```text
<Shows>/
└── <Show Title (YEAR)> {edition-<Edition Name>}/
    ├── Season 01/
    │   ├── <Show Title (YEAR)> - S01E01 - <Episode Title>.<ext>
    │   ├── <Show Title (YEAR)> - S01E02-E03 - <Episode Title>.<ext>
    │   └── ...
    └── Specials/
        └── <Show Title (YEAR)> - S00E01 - <Episode Title>.<ext>
```

**Naming rules:**

- **Show folder:** `Show Title (YEAR)` — year in parentheses
- **Optional edition tag:** `{edition-<Name>}` after the year, on the **show folder only** — see _Editions_ below
- **Season folder:** `Season XX` — two-digit zero-padded number (`Season 01`, not `Season 1`)
- **Episode file:** `Show Title (YEAR) - S01E01 - Episode Title.<ext>`
  - The trailing `- Episode Title` portion is optional, but files without it are summarized as missing titles
  - Multi-episode files use `S01E01-E02`
  - Episode numbers are zero-padded to two digits; three are fine for long-running specials (`S00E201`). An unpadded `S02E4` is flagged, and `fix:shows --fix episode-code` pads it
  - Plex reads `s01e01` and `S01E01` alike. To keep your library consistent, set a house style with [`episode_code_case`](CONFIG.md#episode_code_case)

**Special seasons:**

Plex's `Specials` convention (behind-the-scenes, pilots, etc.) is supported via `rules/shows.yaml`. Folders listed here bypass the `Season XX` regex check and are accepted as-is:

```yaml
ignored_season_names:
  - Specials
  - Champion of Champions
```

**Editions:**

A second cut of the same series — a colorized version alongside the black-and-white original, a Bluray remaster — is an **edition**. Tag the show folder and Plex keeps each one as its own library item, with its own watch status and ratings:

```text
Shows/HD/
├── Spider-Noir (2026) {edition-Authentic Black and White}/
│   └── Season 01/
│       └── Spider-Noir (2026) - S01E01 - Step Into My Office.mp4
└── Spider-Noir (2026) {edition-True Hue Color}/
    └── Season 01/
        └── Spider-Noir (2026) - S01E01 - Step Into My Office.mp4
```

- **The tag goes on the show folder, and nowhere else.** Plex defines an edition at the show level — not per-season, not per-episode — so the episode files inside keep their plain `Show Title (YEAR) - S01E01` names. `fix:shows --fix show-prefix` strips the tag when it rebuilds a prefix.
- **Each edition is its own catalog entry**, with its own seasons and episodes. Two editions of one season are never reported as duplicate copies of each other.
- **Only `{edition-…}` counts.** A bracketed suffix like `[True Hue Color]` is not an edition to Plex — it still fires `warn_bad_show_folder`.
- **Requirements:** adding or editing edition info needs a Plex Pass on the server admin account, and Plex Media Server 1.43.3 or newer.
- **Renaming an existing folder loses its watch history** — Plex treats the renamed folder as a new item.

This is the shows equivalent of the movies `{edition-…}` filename tag above; the difference is which level carries it.

**Examples:**

```text
Shows/
└── Star Trek Enterprise (2001)/
    ├── Season 01/
    │   ├── Star Trek Enterprise (2001) - S01E01-E02 - Broken Bow Part 1 And 2.mp4
    │   ├── Star Trek Enterprise (2001) - S01E03 - Fight or Flight.mp4
    │   └── Star Trek Enterprise (2001) - S01E04 - Strange New World.mp4
    └── Specials/
        └── Star Trek Enterprise (2001) - S00E01 - Behind the Scenes.mp4
```

**Gotchas:**

- **`Season 1` isn't `Season 01`.** Season folders must be zero-padded, unless the name is listed in `ignored_season_names`.
- **Episodes need a season folder.** Files directly in a show folder are **not** added to the catalog, and neither are files in a subfolder inside a season.
- **Gap detection counts multi-episode files fully** — `S01E01-E02` covers episodes 1 and 2. It only sees gaps _between_ episodes you have; a missing final episode needs the [TMDB episode count](SCANS.md#what-it-catches) check.
- **Too many files to rename by hand?** [`npm run fix:shows`](SCANS.md#fixing-filenames--npm-run-fixshows) can repair show prefixes, add episode titles, and normalize episode codes.

---

## Music

Music follows Plex's `Artist / Album / Track` layout, quoted directly from their docs:

> Content should have each artist in their own directory, with each album as a separate subdirectory within it.
>
> `Music/ArtistName/AlbumName/TrackNumber - TrackName.ext`
>
> For albums that span more than one disc, you simply prepend the disc number to the front of the track number. So, track two on disc three would be `302 - TrackName.ext`.

**Folder layout:**

```text
<Music>/
└── <Artist Name>/
    └── <Album Name>/
        ├── 01 - Track Name.<ext>           ← single-disc
        ├── 101 - Track Name.<ext>          ← multi-disc: disc 1, track 1
        └── 201 - Track Name.<ext>          ← multi-disc: disc 2, track 1
```

**Naming rules:**

- **Artist folder:** any name. Plex doesn't enforce a format; the default regex matches anything non-empty
- **Album folder:** any name. Plex doesn't enforce a format (no year required — the year lives in the embedded music tag)
- **Track file (single-disc):** `<2-digit track> - <Track Name>.<ext>` — e.g. `01 - In the Flesh.flac`
- **Track file (multi-disc):** `<disc><2-digit track> - <Track Name>.<ext>` — e.g. `101 - In the Flesh.flac` (disc 1, track 1)

The scanner tries the multi-disc pattern first (it's more specific) and falls back to single-disc.

**Compilations and multi-artist albums:**

Quoting Plex verbatim:

> Sometimes, you may have compilation albums where there are tracks by multiple different artists. This is common for soundtracks or "Best of the 80s" type albums, for instance. The common way to handle this is to use an artist with the literal name "Various Artists" and to have those albums under that artist.

So:

- **Single-composer scores** (e.g. Halo OSTs by Marty O'Donnell and Michael Salvatori): use a comma-separated artist folder like `Marty O'Donnell, Michael Salvatori`. This matches how audiobooks handle multi-author folders and avoids the slash character, which isn't legal in folder names.
- **Multi-artist compilations** (e.g. Guardians of the Galaxy: Awesome Mix, "Best of the 90s", mixed-artist soundtracks): use the literal `Various Artists` as the artist folder.

For Various Artists albums, the embedded `Album Artist` tag should be `Various Artists` and the per-track `Artist` should be the actual performer. The scanner flags mismatches via `warn_folder_tag_mismatch`.

**Examples:**

```text
Music/
├── Pink Floyd/
│   └── The Wall/
│       ├── 101 - In the Flesh.flac
│       ├── 102 - The Thin Ice.flac
│       ├── 201 - Hey You.flac
│       └── 202 - Is There Anybody Out There.flac
└── Various Artists/
    └── Guardians Of The Galaxy - Awesome Mix Vol. 1/
        ├── 01 - Hooked On A Feeling.mp3
        └── 02 - Go All The Way.mp3
Soundtracks/
└── Marty O'Donnell, Michael Salvatori/      ← two composers, comma-separated
    └── Halo Original Soundtrack/
        ├── 01 - Truth and Reconciliation Suite.flac
        └── ...
```

**Gotchas:**

- Track numbers must be zero-padded to two digits — `1 - Track` doesn't match
- Trailing whitespace or Windows-illegal characters in artist or album folders silently split an artist in Plex, so they're flagged
- Audio files loose in a category folder or directly in an artist folder are **not** added to the catalog
- Embedded tags matter as much as folders: Plex groups by the `Album Artist` tag, so a tag that disagrees with its folder is flagged. See [Embedded music tags](SCANS.md#embedded-music-tags)
- The scanner doesn't recurse into subfolders inside an album — multi-disc albums must use the flat disc-prefixed convention (`101`, `201`, etc.)
- The disc number prefix is greedy: a file named `100 - Track` parses as disc 1, track 00 (because the multi-disc pattern is tried first)
- `warn_folder_tag_mismatch` accounts for what Windows allows in a folder name: Windows-illegal characters (`< > : " | ? * \ /`) and trailing periods/spaces are dropped from the tag before comparison. So an `AlbumArtist` tag of `P.O.D.` matches the folder `P.O.D`, `AC/DC` matches `ACDC`, and `Billboard Hits U.S.A.` matches `Billboard Hits U.S.A` — no warning fires for those

---

## Audiobooks

MOASYS-Vault uses an `Author / Book / Chapter` structure that mirrors music's Artist / Album / Track shape. Plex doesn't have a dedicated audiobook agent, but this music-style structure works for properly organized audiobooks.

**Folder layout:**

```text
<Audiobooks>/
└── <Author Name>/
    └── <Book Title>/
        ├── 01 - Chapter Name.<ext>
        └── 02 - Chapter Name.<ext>
```

**Naming rules:**

- **Author folder:** single author (`J.R.R. Tolkien`) or multi-author — see below
- **Book folder:** the book title (no year required)
- **Chapter file:** same convention as music tracks (`01 - Chapter` single-disc, `101 - Chapter` for multi-disc)

**Multi-author folders:**

The author folder name is parsed into a list of individual authors stored in your catalog JSON. Three formats are supported:

| Folder name                        | Parsed authors                         |
| ---------------------------------- | -------------------------------------- |
| `J.R.R. Tolkien`                   | `["J.R.R. Tolkien"]`                   |
| `Terry Pratchett, Neil Gaiman`     | `["Terry Pratchett", "Neil Gaiman"]`   |
| `Author 1, Author 2, and Author 3` | `["Author 1", "Author 2", "Author 3"]` |

**Examples:**

```text
Audible/
└── J.R.R. Tolkien/
    └── The Hobbit/
        ├── 01 - An Unexpected Party.m4b
        └── 02 - Roast Mutton.m4b
Book On CD/
└── Terry Pratchett, Neil Gaiman/
    └── Good Omens/
        ├── 101 - Chapter 1.mp3
        ├── 102 - Chapter 2.mp3
        ├── 201 - Chapter 1.mp3
        └── 202 - Chapter 2.mp3
```

**Gotchas:**

- Books are keyed by title only — the same title by different authors collides, and is reported as a duplicate if it sits in two categories. Intentional, but worth knowing.
- Spelling drift across books is flagged: `Gaunt's Ghost` vs `Gaunt's Ghosts` in series names, `Tobias S. Buckell` vs `Tobias Buckell` in author folders. Plex treats each spelling as a different series or person.
- No quality dimension check applies to audiobooks — spoken word at modest bitrates is fine. Codec and bitrate are still collected during the file inspection pass.
- The same flat / disc-prefixed convention applies for multi-disc books — no per-disc subfolders.
