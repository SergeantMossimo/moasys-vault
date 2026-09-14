# Plex Integration

MOASYS-Vault can read your Plex Media Server to pull library catalogs and collections, then compare what Plex has with what's actually on disk.

- **`npm run plex:pull`** downloads every library's catalog and collections into `output/plex/`.
- **`npm run plex:check`** compares that pull with your latest scan and writes Plex hygiene warnings next to your other warnings.

> **Read-only, like the rest of the scanner.** The Plex client can only send GET requests — it has no way to refresh a library, fix a match, empty the trash, or delete anything. Every warning tells you what to do in Plex; you do it.

---

## Setup

You need two things: where the server is, and a token to access it. They're kept in separate files so the token never lands in a file you commit.

### 1. Server address — `config.json`

Add a `plex` block alongside your media roots:

```json
{
  "movies": [{ "root_path": "M:\\Movies", "name": "Server" }],
  "shows": [{ "root_path": "M:\\Shows", "name": "Server" }],
  "music": [{ "root_path": "M:\\Audio", "name": "Server" }],
  "audiobooks": [{ "root_path": "M:\\Audiobooks", "name": "Server" }],
  "plex": {
    "url": "http://192.168.1.50:32400"
  }
}
```

`url` is the address of the machine running Plex Media Server, on port `32400`. Use the server's LAN IP or hostname. On a home network plain `http://` is fine.

If the server's **Settings → Network → Secure connections** is set to **Required**, use its `https://…plex.direct:32400` address instead — a plain `https://<ip>` address won't pass certificate checks.

### 2. Token — `.secrets.json`

Copy `.secrets.json.example` to `.secrets.json` if you haven't already, and fill in the `plex` block:

```json
{
  "plex": {
    "token": "your-plex-token"
  }
}
```

To find your token:

1. Sign in to Plex Web as the server owner.
2. Open any movie or episode, then **⋯ → Get Info → View XML**.
3. The page URL ends in `X-Plex-Token=…` — that value is your token.

`.secrets.json` is gitignored. Only the blocks a command uses are validated, so an unfilled `tmdb` placeholder won't stop the Plex commands. Your token changes if you sign out of all devices or change your Plex password — update it here when that happens.

### How the token is handled

- Sent only in the `X-Plex-Token` request header, never in a URL.
- Redacted from every error message.
- Never written to `output/` or `cache/`.

---

## `npm run plex:pull [library…]`

Reads every library on the server and writes one folder per library:

```text
output/plex/
├── libraries.json            ← index of every library
├── movies/
│   ├── catalog.json          ← every item, its external ids, and its files
│   └── collections.json      ← every collection and its items
├── tv-shows/
│   ├── catalog.json
│   └── collections.json
└── music/
    ├── catalog.json
    └── collections.json
```

Each folder name is the library's title, lowercased with unsafe characters replaced (`TV Shows` → `tv-shows`). If two titles would produce the same folder name, the library's key is appended. Photo libraries are skipped.

Output is split per library because a large server makes one combined file unwieldy. Libraries are written as each one finishes, so if the connection drops, the libraries already pulled are kept.

Pull only some libraries by naming them — the library title or its folder name, case-insensitive:

```bash
npm run plex:pull movies "tv shows"
```

`libraries.json` always lists every library; libraries you didn't pull this time keep their counts from the previous pull.

### What's in a catalog

| Library type | Items pulled                |
| ------------ | --------------------------- |
| Movies       | movies                      |
| TV Shows     | shows, episodes             |
| Music        | artists, albums, and tracks |

Each item carries its Plex title, original title, year, agent guid, external ids (`imdb://`, `tmdb://`, `tvdb://`), parent/grandparent keys and titles, whether Plex lists it under **Duplicates**, and its files. Each file records the path as Plex sees it, the configured drive and library-relative path it maps to on this machine, and whether Plex has flagged it deleted.

A pull of a few thousand movies and a few hundred shows takes a minute or two. There's no cache — the pull output _is_ the snapshot `plex:check` reads, so re-pull whenever you want fresh data.

---

## Mapping Plex paths to your drives

Plex reports files as the server sees them — on a NAS, something like `/volume1/Media/Movies/HD/Heat (1995)/Heat (1995).mkv`. To compare those with your scans, each Plex library folder has to be matched to a root in `config.json`.

**Automatic.** A library folder maps to the root whose last folder name appears in its path:

| Plex library folder         | Maps to                                   |
| --------------------------- | ----------------------------------------- |
| `/volume1/Media/Movies`     | `M:\Movies` (Server)                      |
| `/volume1/Media/Movies/UHD` | `M:\Movies`, with files under `UHD/`      |
| `/volume1/Media/Audiobooks` | `M:\Audiobooks` — even in a Music library |

That last row is how a Music-type Plex library holding audiobooks is recognized as audiobooks: media type follows the folder, not the Plex library type.

The pull prints a line for any library folder that matches no root, or matches more than one.

**Explicit.** When your folder names don't line up, add `path_map` entries that translate a Plex path prefix to a local one. The longest matching prefix wins, and `path_map` always takes priority over automatic matching:

```json
"plex": {
  "url": "http://192.168.1.50:32400",
  "path_map": [
    { "plex": "/volume1/Media", "local": "M:\\" },
    { "plex": "/volumeUSB1/usbshare", "local": "D:\\" }
  ]
}
```

---

## `npm run plex:check [drive]`

Compares the last pull with the last scan of every media type on one drive — no connection to Plex needed. Omit the drive for the first root of each type, just like the scan commands.

It reads `output/plex/` and each type's `output/<drive>/<type>/probe.json`, and writes:

```text
output/<drive>/<type>/plex-warnings.json
```

Same shape as `warnings.json`, and your `ignored/<drive>/<type>.yaml` lists apply to it. Run the scan and `plex:pull` first:

```bash
npm run scan:all
npm run validate:movies   # optional, but makes the title check compare TMDB ids
npm run validate:shows
npm run plex:pull
npm run plex:check
```

To check a single media type:

```bash
npx tsx src/plex/check.ts --type movies
```

### Warnings

| Warning                           | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn_plex_folder_not_in_library` | Files sitting in a folder that none of the library's folders cover — Plex will never scan them, however often you rescan. Reported once at the shallowest such folder (e.g. a whole `Other Audible/` category). Add the folder to the library, or move the files.                                                                                                                                                                                                                                         |
| `warn_plex_missing_item`          | Files inside a library folder that no Plex item points at, grouped per folder. Plex never picked them up — run **Scan Library Files**; if they still don't appear, the names likely break Plex's naming convention.                                                                                                                                                                                                                                                                                       |
| `warn_plex_orphan_item`           | Files Plex still lists that are gone from disk, and Plex hasn't noticed. Run **Scan Library Files**, then **Empty Trash** — or restore the files.                                                                                                                                                                                                                                                                                                                                                         |
| `warn_plex_unavailable`           | Files Plex has flagged deleted — they're in the library's trash and show as unavailable. **Empty Trash** once you're sure; if they're back on disk, **Scan Library Files** restores them.                                                                                                                                                                                                                                                                                                                 |
| `warn_plex_unmatched`             | A movie, show, or album Plex couldn't match to its agent. Use **Fix Match…**. Skipped for libraries using the Personal Media agent, where nothing is ever matched, and for audiobooks, which Plex looks up in music databases that don't carry them.                                                                                                                                                                                                                                                      |
| `warn_plex_title_mismatch`        | Plex probably matched the wrong movie or show. When the validate pass has run, this compares TMDB ids: Plex's id vs the one the validator matched — same-title films and remakes are caught even when the titles are identical, and a different title with the same id is not reported. Without validation it compares titles, allowing canonical titles that wrap the folder's (`Star Wars: Episode VI - Return of the Jedi`), Plex's `(2014)` / `(US)` suffixes, leading articles, and years one apart. |
| `warn_plex_title_case`            | Plex's title matches the folder except for capitalization.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `warn_plex_duplicate`             | Plex lists the item under **Duplicates** — several files merged into one entry. Fine for deliberate versions like HD + UHD or a director's cut; if they're different titles, **Split Apart** in Plex. Editions (`{edition-…}`) are separate Plex items, so they don't appear here.                                                                                                                                                                                                                        |

Toggle any of these in `rules/plex.yaml` (or `rules/plex.local.yaml` for personal overrides).

### What it compares

- **Files on disk** come from `probe.json`, which lists every _primary-format_ file the scan inspected. A file in a non-primary format that's missing from Plex isn't reported; one Plex has that isn't in `probe.json` is checked directly on disk before being called an orphan.
- **Title checks** run for movies and shows only, once per folder (editions share one), using the folder pattern from `rules/movies.yaml` / `rules/shows.yaml`. Run `npm run validate:movies` / `validate:shows` first for the more precise TMDB-id comparison; only high- and medium-confidence validation matches are used. Music and audiobook titles in Plex come from embedded tags, which the scan already compares with folders.
- **Only this drive.** Plex files that map to a different drive, or to no configured root, are left out.
