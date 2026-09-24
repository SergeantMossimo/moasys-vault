/**
 * core/types.ts
 * ------------
 * Shared TypeScript interfaces used across all media modules and the core scanner.
 * Defining types here means any structural change is caught by the compiler
 * everywhere it's used — no silent mismatches between modules.
 */

import { canonicalName, deriveScope, EMPTY_IGNORE_LIST, isWarningIgnored } from './ignored'
import type { IgnoreList, IgnoreMediaType, WarningScope } from './ignored'

// ─────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────

/**
 * One entry in the categories rules array — a subfolder under root_path
 * that the scanner walks. Re-exported from core/rules/helpers.ts.
 */
import type { Category, ResolvedCategory } from './rules/helpers'
import type { ProbeData } from '../probe/types'
export type { Category, ResolvedCategory }

/**
 * Shared fields present in every media type config section.
 * config.json now only carries the per-machine root_path. Everything else
 * (extensions, patterns, conventions, the categories list) lives in the
 * rules layer (src/core/rules/<type>.ts and rules/<type>.yaml).
 *
 * This is the *per-root* shape — one run always targets exactly one root, so
 * scan(), the probe walkers, and the media modules all keep taking a single
 * `root_path` even though config.json now lists several per type.
 */
export interface BaseMediaConfig {
  root_path: string
  /** Files the probe pass inspects at once. Omitted = 1 (sequential). */
  probe_concurrency?: number
}

/**
 * One named root in config.json's per-type array. `name` identifies the drive
 * (e.g. "Server", "External") and — lowercased via `driveSlug()` — becomes the
 * folder segment for that drive's cache, ignored, and output files.
 *
 * A MediaRootConfig is a superset of BaseMediaConfig, so it can be handed
 * straight to scan() / probe*() with no unwrapping.
 */
export interface MediaRootConfig extends BaseMediaConfig {
  name: string
}

/**
 * Per-type config interfaces. All four are structurally identical to
 * BaseMediaConfig — kept as named aliases for documentation and so future
 * per-type config fields have a natural home.
 *
 * Deliberately *not* MediaRootConfig: the media modules and probe walkers
 * only ever need `root_path`, and a MediaRootConfig satisfies that
 * structurally. Keeping the narrower type here means nothing below the
 * runner has to know that a drive has a name.
 */
export type MoviesConfig = BaseMediaConfig
export type ShowsConfig = BaseMediaConfig
export type MusicConfig = BaseMediaConfig
export type AudiobooksConfig = BaseMediaConfig

/**
 * The full shape of config.json. Each media type is a list of named roots,
 * ordered — the first entry is the default when a run doesn't name a drive.
 * A type you don't have is simply left out; read lists through `rootsFor()`.
 */
export interface AppConfig {
  _notes?: Record<string, string> // Optional documentation keys — ignored by scanner
  movies?: MediaRootConfig[]
  shows?: MediaRootConfig[]
  music?: MediaRootConfig[]
  audiobooks?: MediaRootConfig[]
  /** Optional Plex connection settings — see `PlexConfigSchema` in core/config.ts. */
  plex?: {
    url: string
    path_map?: Array<{ plex: string; local: string }>
  }
}

// ─────────────────────────────────────────────
// Warning types
// ─────────────────────────────────────────────

/**
 * A single warning as a check emits it, with the full library-relative `path`.
 * The on-disk form (`WarningRow`) keeps the type but shortens the path to be
 * relative to its folder entry — see `WarningCollector.groupedByFolder`.
 */
export interface Warning {
  type: string // Stable machine-readable identifier (e.g. 'warn_bad_folder_name')
  path: string
  issue: string
  extension?: string // Optional — only present for non-primary file warnings
}

/** Optional extras on a warning. See `WarningCollector.add`. */
export interface WarningOptions {
  /**
   * File extension for the offending file, surfaced on the row. Only set by
   * the `warn_non_primary` checks, which exist to tell you which formats are
   * still lurking in the library.
   */
  extension?: string
  /**
   * Where this warning sits in the library hierarchy, for ignore-list
   * matching. Set it only when `path` isn't a real category-anchored library
   * path — the duplicate-copy checks emit a display label with no category
   * (`Firefly (2002) — Season 1`), and the TMDB episode-name check emits an
   * episode CODE where a filename would normally sit. Everything else derives
   * correctly from `path` and should leave this alone.
   */
  scope?: WarningScope
  /**
   * How to fix every row of this warning type.
   *
   * **Accepted and ignored.** The remedy is no longer written to the warnings
   * files — it is identical for every row of a type, so its home is the
   * warning tables in docs/OUTPUT.md and the `FIX` maps beside each check.
   * The option is still taken so the ~100 call sites that pass it keep
   * compiling and keep documenting their remedy where the check lives.
   */
  fix?: string
}

/**
 * One row inside a folder entry on disk.
 *
 * `path` is relative to the folder's `path` — the folder carries the shared
 * prefix once, so a row reads `Season 09` rather than repeating
 * `SD/Good Eats (1999)/Season 09`.
 */
export interface WarningRow {
  /**
   * Stable warning identifier — the key into the file's `by_type`, the toggle
   * name under `checks` in rules/<type>.yaml, and the row in the
   * docs/OUTPUT.md warning table that gives the remedy.
   */
  type: string
  /**
   * Location relative to the folder's `path`, forward-slash-normalized.
   * **Absent means the warning is about the folder itself.**
   */
  path?: string
  issue: string
  extension?: string
}

/**
 * Every warning on one top-level library folder — a show, movie, artist, or
 * author. This is the unit the user actually works in: they sit down to fix
 * one show, so one show is one entry, however many checks fired on it.
 *
 * Deliberately flat. A season, album, or book is a relative `path` on a row,
 * never a nested entry — nesting would give each media type a different shape
 * and buy nothing the relative path doesn't already say.
 *
 * Nothing here restates what another field already carries. The folder's own
 * name and its category are the last and first segments of `path`, and the
 * distinct types on it are one pass over `rows` — all three used to be written
 * out per folder, which cost 13–18% of every warnings file.
 */
export interface WarningFolder {
  /**
   * Full library-relative prefix the rows hang off: `SD/Good Eats (1999)`.
   *
   * The last segment is the name an ignore entry uses. A path with no `/` is
   * either a category folder — silenced under `folders:` — or, in a library
   * with no `categories`, the top-level name itself.
   */
  path: string
  /** `rows.length`, so the worst offenders are greppable. */
  count: number
  rows: WarningRow[]
}

/**
 * The on-disk shape of warnings.json / validation-warnings.json /
 * plex-warnings.json / plex-log-warnings.json.
 *
 * Warnings are grouped by the top-level folder they concern, because that is
 * the unit of work: one show is one entry, not eight rows scattered across
 * type buckets. The two things that are constant per *type* rather than per
 * folder — the remedy and the tally — sit at the top of the file so they are
 * written once each and stay answerable without walking `folders`.
 *
 * `folders` is sorted alphabetically by `path`, so a diff between two runs
 * shows what actually changed in the library.
 */
export interface WarningsOutput {
  generated: string // ISO 8601 UTC timestamp
  /** Total rows across every folder. Excludes anything the ignore list silenced. */
  count: number
  /** `folders.length`. */
  folder_count: number
  /**
   * How many rows each warning type produced, worst first. Same key set and
   * order as `countByType()`, so the console breakdown and the file can't
   * disagree. Sparse — only types with at least one hit appear.
   */
  by_type: Record<string, number>
  folders: WarningFolder[]
}

// ─────────────────────────────────────────────
// The merged report (all-warnings.json)
// ─────────────────────────────────────────────

/** Whether a source file could be folded into the merged report. */
export type SourceStatus = 'ok' | 'missing' | 'stale' | 'unreadable'

/**
 * One command's contribution to the merged report.
 *
 * Read this block before the folders. A command that has never run reports
 * `count: null`, **never `0`** — otherwise a report missing half its checks
 * would look like a clean library.
 */
export interface WarningSource {
  /** The npm command that writes this file — what you re-run to refresh it. */
  command: string
  /** File name within output/<drive>/<type>/. */
  file: string
  status: SourceStatus
  /** The source's own timestamp, or null when it wasn't read. */
  generated: string | null
  /** Rows folded in from this source, or null when it wasn't read. */
  count: number | null
  /** Why, for anything but `ok` — already phrased for printing. */
  note?: string
}

/** A merged row, tagged with the command that found it. */
export interface MergedWarningRow extends WarningRow {
  /** `scan` | `validate` | `plex:check` | `plex:logs`. */
  command: string
}

/** A merged folder entry, tagged with every command that flagged it. */
export interface MergedWarningFolder extends Omit<WarningFolder, 'rows'> {
  /** The commands that flagged this folder, in pipeline order. */
  commands: string[]
  rows: MergedWarningRow[]
}

/**
 * The on-disk shape of all-warnings.json — every command's warnings for one
 * drive and media type, folded into one entry per folder. Written by
 * `npm run report`; a superset of `WarningsOutput`.
 */
export interface MergedWarningsOutput {
  generated: string
  drive: string
  media_type: string
  /**
   * Every command that can contribute for this media type, whether or not each
   * one was readable — four, or three for music, which has no validate pass.
   * Read this first.
   */
  sources: WarningSource[]
  count: number
  folder_count: number
  by_type: Record<string, number>
  folders: MergedWarningFolder[]
}

// ─────────────────────────────────────────────
// Version (unified per-copy descriptor)
// ─────────────────────────────────────────────

/**
 * One physical copy of a media item — where it lives (category) and what
 * quality it is. The same record can have multiple versions when it lives
 * in more than one category, or when its tracks/episodes have multiple
 * codecs/resolutions.
 *
 * For movies/shows, `quality` is derived from probe data (long-edge px
 * mapped against quality_thresholds) and is null until the probe pass has
 * run. For music/audiobooks, `quality` is the file extension uppercased
 * (FLAC, MP3, AAC, etc.) and is always populated during scan.
 */
export interface Version {
  category: string
  quality: string | null
}

// ─────────────────────────────────────────────
// Movie types
// ─────────────────────────────────────────────

/** Internal record for a single movie (or edition) during scanning */
export interface MovieRecord {
  title: string
  year: number
  edition: string | null // null = no edition tag, string = edition name
  versions: Version[] // may contain duplicates; deduped on serialize
}

/** One entry in movies.json */
export interface MovieOutput {
  title: string
  year: number
  edition: string | null
  versions: Version[] // sorted by category order, then by quality
}

// ─────────────────────────────────────────────
// Show types
// ─────────────────────────────────────────────

/**
 * One episode (or multi-episode file) parsed from disk. Carried through to
 * `shows.json` so downstream consumers (and the TMDB-episode-name validation
 * pass) can join on `(season, episode_start)`.
 *
 *   episode_start === episode_end → single-episode file
 *   episode_start !== episode_end → multi-episode file (e.g. S01E01-E02)
 *   title === null                 → filename omits " - Episode Title"
 */
export interface EpisodeOutput {
  episode_start: number
  episode_end: number
  title: string | null
}

/** Internal record for a single season during scanning */
export interface SeasonRecord {
  season_label: string // "1", "2", "Specials" etc.
  episode_count: number
  versions: Version[]
  episodes: EpisodeOutput[]
}

/**
 * Internal record for a single show (or edition) during scanning.
 *
 * `edition` is Plex's TV Show Editions tag, taken off the show folder
 * (`Spider-Noir (2026) {edition-True Hue Color}`). Two editions of one series
 * are separate Plex items with their own watch state, so they are separate
 * records here too — keyed on title|year|edition, the way movies are.
 */
export interface ShowRecord {
  title: string
  year: number
  edition: string | null // null = no edition tag, string = edition name
  seasons: Map<string, SeasonRecord> // Key = season_key string
}

/** One season entry in shows.json */
export interface SeasonOutput {
  season: string // "1", "2", "Specials"
  episode_count: number
  versions: Version[]
  episodes: EpisodeOutput[]
}

/** One entry in shows.json */
export interface ShowOutput {
  title: string
  year: number
  edition: string | null
  seasons: SeasonOutput[]
}

// ─────────────────────────────────────────────
// Music types
// ─────────────────────────────────────────────

/** Internal record for a single album during scanning */
export interface AlbumRecord {
  album: string
  track_count: number
  versions: Version[] // (category, codec) pairs; deduped on serialize
}

/** Internal record for a single artist during scanning */
export interface ArtistRecord {
  artist: string
  albums: Map<string, AlbumRecord> // Key = album_key string
}

/** One album entry in music.json */
export interface AlbumOutput {
  album: string
  track_count: number
  versions: Version[]
}

/** One entry in music.json */
export interface ArtistOutput {
  artist: string
  albums: AlbumOutput[]
}

// ─────────────────────────────────────────────
// Audiobook types
// ─────────────────────────────────────────────

/** Internal record for a single book during scanning */
export interface BookRecord {
  title: string
  authors: string[] // e.g. ["Terry Pratchett", "Neil Gaiman"]
  /**
   * The author folder name exactly as on disk. Internal only — the name
   * checks need it to suggest a rename, and `authors.join(', ')` can't
   * reproduce folders written `A, B, and C`.
   */
  author_folder: string
  chapter_count: number
  versions: Version[] // (category, codec) pairs; deduped on serialize
}

/** One entry in audiobooks.json */
export interface BookOutput {
  title: string
  authors: string[]
  chapter_count: number
  versions: Version[]
}

// ─────────────────────────────────────────────
// Media module interface
// ─────────────────────────────────────────────

/**
 * Every media module (movies, shows, music, audiobooks) must conform to this interface.
 * The core scanner calls these functions without knowing which media type it's working with.
 * Adding a new media type means implementing this interface in a new file.
 */
export interface MediaModule<TRecord, TOutput, TConfig extends BaseMediaConfig> {
  /**
   * Return the effective categories for this module. The factory resolves
   * this from rules.categories, synthesizing a single-entry list pointing
   * at root_path (name: "default", folderName: "") when the user hasn't
   * configured any. The core scanner iterates whatever this returns.
   */
  getCategories(): ResolvedCategory[]

  /**
   * Walk one category folder and return a map of records found.
   *
   * `probeByPath` provides ffprobe results keyed by relative path (forward
   * slashes) so video modules can derive a `quality` for each version from
   * the file's dimensions. Audio modules generally ignore it and key off
   * the file extension instead.
   */
  scanCategory(
    folderPath: string,
    folderName: string,
    category: string,
    config: TConfig,
    warnings: WarningCollector,
    probeByPath: Map<string, ProbeData>
  ): Map<string, TRecord>

  /** Merge records from one media folder into the accumulated results */
  merge(existing: Map<string, TRecord>, incoming: Map<string, TRecord>): void

  /** Convert internal records to the final output shape for JSON */
  serialize(records: Map<string, TRecord>): TOutput[]

  /**
   * Optional: runs once after all media folders have been scanned and merged.
   * Use for warnings that need the fully-merged records map (e.g. movies'
   * multi-quality check, which can only fire once a movie's qualities Set is
   * complete across all folders).
   */
  postScan?(records: Map<string, TRecord>, warnings: WarningCollector): void
}

// ─────────────────────────────────────────────
// Warning collector class
// ─────────────────────────────────────────────

/**
 * The folder a warning belongs to, reduced to the two things the grouping
 * needs: `prefix`, which a row's path is made relative to and which is written
 * to disk as the folder's `path`, and `key`, which decides what merges.
 *
 * The category and the top-level name stay local. They are what `key` is built
 * from, but neither is written out — both are readable off `prefix`.
 *
 * `key` folds case so `HD/Firefly (2002)` and `HD/firefly (2002)` can't split
 * one show into two entries. It uses NUL as the separator because no path
 * segment can contain one — a `/` would let `a/b` + `c` collide with `a` +
 * `b/c`.
 */
function folderOf(scope: WarningScope): {
  key: string
  prefix: string
} {
  const category = scope.categories[0]
  const name = scope.levels[0] ?? category ?? ''
  const prefix = [category, scope.levels[0]].filter(s => s !== undefined && s !== '').join('/')
  const fold = (s: string): string => s.trim().toLowerCase()
  return {
    key: `${fold(category ?? '')} ${fold(name)}`,
    prefix,
  }
}

/**
 * A row's path relative to its folder's prefix, or undefined when the row is
 * about the folder itself.
 *
 * Most checks pass a real category-anchored path, which is a plain prefix
 * strip. The handful that pass a display label instead (`options.scope`) fall
 * back to rebuilding the tail from the scope's own levels — so
 * `Firefly (2002) — Season 1` becomes the folder `HD/Firefly (2002)` plus the
 * row `Season 1`, losing nothing.
 */
function relativePath(fullPath: string, prefix: string, scope: WarningScope): string | undefined {
  if (prefix !== '' && fullPath === prefix) return undefined
  if (prefix !== '' && fullPath.startsWith(`${prefix}/`)) return fullPath.slice(prefix.length + 1)
  const tail = scope.levels.slice(1).join('/')
  return tail === '' ? undefined : tail
}

/**
 * Accumulates warning messages during a scan.
 * Passed into each media module so warnings can be added from anywhere
 * in the scanning process and written to warnings.json at the end.
 *
 * If constructed with an `ignored` list, any warning that matches an entry
 * (see `core/ignored.ts` for matching semantics) is silently dropped — the
 * user's way of permanently silencing warnings they can't or don't want to
 * fix. Silenced warnings are still counted via `silencedCount()` so the
 * runner can surface "N silenced" in its summary.
 */
/**
 * What the collector actually stores: a `Warning` plus the scope `add()`
 * derived for it. The scope is kept because the folder grouping needs the same
 * `{categories, levels}` split the ignore matcher uses — re-deriving it later
 * would let the two drift apart. It never leaves the collector: `all()` strips
 * it, and nothing on disk carries it.
 */
interface CollectedWarning extends Warning {
  scope: WarningScope
}

export class WarningCollector {
  private warnings: CollectedWarning[] = []
  private silenced = 0
  private readonly ignored: IgnoreList
  /**
   * Media type for the canonical name folds that order rows within a folder;
   * null when no list was supplied, in which case ordering falls back to a
   * plain case-fold.
   */
  private readonly suggestFor: IgnoreMediaType | null

  /**
   * @param ignored       loaded ignore list for this drive + media type. When
   *                      given (even empty), each row also carries a
   *                      ready-to-paste `ignore` entry for that media type.
   * @param hasCategories false when `rules.categories` is empty. Such a
   *                      library has no category segment, so every warning
   *                      path is one level shallower and scope derivation
   *                      must not eat the first segment as a category.
   *                      Derive it from the rules rather than hardcoding —
   *                      getting it backwards silences the wrong things
   *                      rather than raising an error.
   */
  constructor(
    ignored?: IgnoreList,
    private hasCategories: boolean = true
  ) {
    this.ignored = ignored ?? EMPTY_IGNORE_LIST
    this.suggestFor = ignored?.mediaType ?? null
  }

  /** Add a warning. type, path, and issue are required; `options` is optional.
   *  - type:   stable machine-readable identifier (e.g. 'warn_bad_folder_name'),
   *            used for grouping in warnings.json and as the `checks` toggle name.
   *  - path:   library-relative location. Backslashes are normalized to forward
   *            slashes so output is consistent across Windows and macOS/Linux.
   *  - issue:  human-readable description of the problem — the facts that
   *            differ row to row. The remedy goes in `options.fix`, not here.
   *  - options: `extension`, `scope` and `fix` — see `WarningOptions`. */
  add(type: string, path: string, issue: string, options: WarningOptions = {}): void {
    const normalizedPath = path.replace(/\\/g, '/')
    // Always derived, even with no ignore list: the folder grouping keys on it,
    // so it can't be conditional or two collectors would produce two different
    // on-disk shapes. It's one split per warning — the cost is nil.
    const scope = options.scope ?? deriveScope(normalizedPath, this.hasCategories)
    if (this.ignored.entries.length > 0 && isWarningIgnored(scope, this.ignored)) {
      this.silenced++
      return
    }
    const entry: CollectedWarning = { type, path: normalizedPath, issue, scope }
    if (options.extension !== undefined) entry.extension = options.extension
    this.warnings.push(entry)
  }

  /**
   * Return a flat copy of all collected warnings, sorted the same way the
   * on-disk rows are (see `compareRows`). Used by tests and by the per-type
   * summary in the run output; the on-disk shape is built via
   * `groupedByFolder()`.
   */
  all(): Warning[] {
    return [...this.warnings]
      .sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type)
        return a.path.localeCompare(b.path)
      })
      .map(w => {
        // Rebuilt field by field rather than spread-and-delete so `scope`,
        // which is a collector-internal device, can't leak into a caller's
        // view of a warning.
        const out: Warning = { type: w.type, path: w.path, issue: w.issue }
        if (w.extension !== undefined) out.extension = w.extension
        return out
      })
  }

  /**
   * Return warnings grouped by the top-level folder they concern — the on-disk
   * shape of every warnings file.
   *
   * Folders are sorted alphabetically by path so a diff between runs shows
   * what changed. Within a folder, rows sort by their canonical relative path
   * (folder-level rows first), then type, then issue. Canonical, so a scan's
   * `Season 03` lands next to a TMDB pass's `Season 3` rather than a screen
   * apart — see `canonicalName`.
   */
  groupedByFolder(): WarningFolder[] {
    const groups = new Map<
      string,
      { meta: ReturnType<typeof folderOf>; rows: CollectedWarning[] }
    >()
    for (const w of this.warnings) {
      const meta = folderOf(w.scope)
      const group = groups.get(meta.key)
      if (group) group.rows.push(w)
      else groups.set(meta.key, { meta, rows: [w] })
    }

    const sortPath = (w: CollectedWarning, prefix: string): string => {
      const rel = relativePath(w.path, prefix, w.scope)
      if (rel === undefined) return '' // folder-level rows sort first
      if (this.suggestFor === null) return rel.toLowerCase()
      // Segment i of the relative path sits at level 2 + i: the folder itself
      // is level 1. That is what routes a shows season through the season fold.
      return rel
        .split('/')
        .map((seg, i) => canonicalName(this.suggestFor!, 2 + i, seg))
        .join('/')
    }

    return [...groups.values()]
      .map(({ meta, rows }) => {
        const ordered = [...rows].sort((a, b) => {
          const ka = sortPath(a, meta.prefix)
          const kb = sortPath(b, meta.prefix)
          if (ka !== kb) return ka.localeCompare(kb)
          if (a.type !== b.type) return a.type.localeCompare(b.type)
          return a.issue.localeCompare(b.issue)
        })

        const folder: WarningFolder = {
          path: meta.prefix,
          count: ordered.length,
          rows: ordered.map(w => {
            const rel = relativePath(w.path, meta.prefix, w.scope)
            // Built in one literal so the JSON key order reads
            // type → path → issue → extension, rather than by assignment order.
            const row: WarningRow = {
              type: w.type,
              ...(rel !== undefined ? { path: rel } : {}),
              issue: w.issue,
              ...(w.extension !== undefined ? { extension: w.extension } : {}),
            }
            return row
          }),
        }
        return folder
      })
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /** `countByType()` as an object, for the file's top-level `by_type` tally. */
  tallyByType(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const { type, count } of this.countByType()) out[type] = count
    return out
  }

  /**
   * Return a per-type tally of warnings collected, sorted by count descending
   * (worst offenders first). Surfaced in the run output as a one-line summary
   * after the existing `Done — X entries, Y warnings.` line.
   */
  countByType(): Array<{ type: string; count: number }> {
    const counts = new Map<string, number>()
    for (const w of this.warnings) {
      counts.set(w.type, (counts.get(w.type) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count
        return a.type.localeCompare(b.type)
      })
  }

  /** Return the total number of warnings collected (excludes silenced). */
  count(): number {
    return this.warnings.length
  }

  /** Return the number of warnings silenced by the ignore list. */
  silencedCount(): number {
    return this.silenced
  }
}
