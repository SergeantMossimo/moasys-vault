/**
 * core/types.ts
 * ------------
 * Shared TypeScript interfaces used across all media modules and the core scanner.
 * Defining types here means any structural change is caught by the compiler
 * everywhere it's used — no silent mismatches between modules.
 */

import { deriveScope, EMPTY_IGNORE_LIST, isWarningIgnored } from './ignored'
import type { IgnoreList, WarningScope } from './ignored'

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
 */
export interface AppConfig {
  _notes?: Record<string, string> // Optional documentation keys — ignored by scanner
  movies: MediaRootConfig[]
  shows: MediaRootConfig[]
  music: MediaRootConfig[]
  audiobooks: MediaRootConfig[]
}

// ─────────────────────────────────────────────
// Warning types
// ─────────────────────────────────────────────

/**
 * A single warning entry. `type` is carried internally so the collector can
 * route to the right bucket; the on-disk form (under `by_type[<type>]`)
 * omits it since the bucket key already encodes the type.
 */
export interface Warning {
  type: string // Stable machine-readable identifier (e.g. 'warn_bad_folder_name')
  path: string
  issue: string
  extension?: string // Optional — only present for non-primary file warnings
  /**
   * Optional ordering override — see `WarningOptions.sortKey`. Internal only;
   * never written to disk, since it's a sorting device rather than data a
   * consumer of warnings.json would act on.
   */
  sortKey?: string
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
   * Overrides `path` when ordering this row within its `by_type` bucket.
   * Lets a check group its rows by something more useful than alphabetical
   * path order — `warn_duplicate_quality` uses `qualitySortKey` so the bucket
   * reads UHD first, then HD, then SD. Ties fall back to `path`, so output
   * stays deterministic. Set it on every row a check emits or none of them;
   * a bucket that mixes the two orders unpredictably.
   */
  sortKey?: string
  /**
   * Where this warning sits in the library hierarchy, for ignore-list
   * matching. Set it only when `path` isn't a real category-anchored library
   * path — the duplicate-copy checks emit a display label with no category
   * (`Firefly (2002) — Season 1`), and the TMDB episode-name check emits an
   * episode CODE where a filename would normally sit. Everything else derives
   * correctly from `path` and should leave this alone.
   */
  scope?: WarningScope
}

/**
 * One row inside a `by_type` bucket on disk. Same as Warning minus `type`,
 * which is implied by the bucket key.
 */
export interface WarningRow {
  path: string
  issue: string
  extension?: string
}

/**
 * The on-disk shape of warnings.json / validation-warnings.json. Warnings are
 * grouped by their type so consumers can scan one bucket at a time without
 * filtering an array. `by_type` is sparse — only types with at least one hit
 * appear as keys. Inside each bucket, rows are sorted alphabetically by path
 * unless the check supplied a `sortKey` (see `WarningOptions`), which lets a
 * bucket group by something more useful — `warn_duplicate_quality` orders by
 * quality, UHD first. Either way the order is deterministic, so output stays
 * stable and diff-friendly across runs.
 */
export interface WarningsOutput {
  generated: string // ISO 8601 UTC timestamp
  count: number
  by_type: Record<string, WarningRow[]>
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

/** Internal record for a single show during scanning */
export interface ShowRecord {
  title: string
  year: number
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
 * Order two warnings within a single type bucket. Checks that supplied a
 * `sortKey` are grouped by it first (e.g. `warn_duplicate_quality` lists all
 * UHD rows, then HD, then SD); everything else falls back to alphabetical
 * path order, which is also the tiebreak inside a sortKey group. Shared by
 * `all()` and `groupedByType()` so the run summary and the on-disk file never
 * disagree about ordering.
 */
function compareRows(a: Warning, b: Warning): number {
  const ka = a.sortKey ?? a.path
  const kb = b.sortKey ?? b.path
  if (ka !== kb) return ka.localeCompare(kb)
  return a.path.localeCompare(b.path)
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
export class WarningCollector {
  private warnings: Warning[] = []
  private silenced = 0

  /**
   * @param ignored       loaded ignore list for this drive + media type
   * @param hasCategories false when `rules.categories` is empty. Such a
   *                      library has no category segment, so every warning
   *                      path is one level shallower and scope derivation
   *                      must not eat the first segment as a category.
   *                      Derive it from the rules rather than hardcoding —
   *                      getting it backwards silences the wrong things
   *                      rather than raising an error.
   */
  constructor(
    private ignored: IgnoreList = EMPTY_IGNORE_LIST,
    private hasCategories: boolean = true
  ) {}

  /** Add a warning. type, path, and issue are required; `options` is optional.
   *  - type:   stable machine-readable identifier (e.g. 'warn_bad_folder_name'),
   *            used for grouping in warnings.json and as the `checks` toggle name.
   *  - path:   library-relative location. Backslashes are normalized to forward
   *            slashes so output is consistent across Windows and macOS/Linux.
   *  - issue:  human-readable description.
   *  - options: `extension`, `sortKey` and `scope` — see `WarningOptions`. */
  add(type: string, path: string, issue: string, options: WarningOptions = {}): void {
    const normalizedPath = path.replace(/\\/g, '/')
    if (this.ignored.entries.length > 0) {
      const scope = options.scope ?? deriveScope(normalizedPath, this.hasCategories)
      if (isWarningIgnored(scope, this.ignored)) {
        this.silenced++
        return
      }
    }
    const entry: Warning = { type, path: normalizedPath, issue }
    if (options.extension !== undefined) entry.extension = options.extension
    if (options.sortKey !== undefined) entry.sortKey = options.sortKey
    this.warnings.push(entry)
  }

  /**
   * Return a flat copy of all collected warnings, sorted the same way the
   * on-disk buckets are (see `compareRows`). Used by tests and by the
   * per-type summary in the run output; the on-disk shape is built via
   * `groupedByType()`.
   */
  all(): Warning[] {
    return [...this.warnings].sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type)
      return compareRows(a, b)
    })
  }

  /**
   * Return warnings grouped by their `type` for writing to warnings.json.
   * Each bucket's rows are ordered by `compareRows` — alphabetically by path
   * unless the check supplied a `sortKey`; the outer keys are sorted as well
   * so JSON serialization is stable across runs. Sparse — only types with at
   * least one hit appear as keys.
   */
  groupedByType(): Record<string, WarningRow[]> {
    const buckets = new Map<string, Warning[]>()
    for (const w of this.warnings) {
      let bucket = buckets.get(w.type)
      if (!bucket) {
        bucket = []
        buckets.set(w.type, bucket)
      }
      bucket.push(w)
    }

    const sortedKeys = [...buckets.keys()].sort()
    const out: Record<string, WarningRow[]> = {}
    for (const key of sortedKeys) {
      // Sort as Warnings (which carry sortKey), then strip to the on-disk
      // row shape — sortKey is an ordering device, not data worth shipping.
      out[key] = buckets
        .get(key)!
        .sort(compareRows)
        .map(w => {
          const row: WarningRow = { path: w.path, issue: w.issue }
          if (w.extension !== undefined) row.extension = w.extension
          return row
        })
    }
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
