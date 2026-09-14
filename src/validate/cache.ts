/**
 * validate/cache.ts
 * -----------------
 * JSON-backed caches for TMDB lookups. Four separate files so each cache
 * stays human-inspectable and debuggable:
 *
 *   cache/tmdb-search.json        ← search lookups   (key = "<type>|<title>|<year>")
 *   cache/tmdb-movies.json        ← movie details   (key = TMDB ID as string)
 *   cache/tmdb-shows.json         ← show details    (key = TMDB ID as string)
 *   cache/tmdb-show-seasons.json  ← per-season ep details (key = "<showId>:<seasonNumber>")
 *
 * Each cache shares the same load/save logic via the generic JsonCache class.
 * Schema mismatches are non-fatal — we discard and rebuild.
 *
 * Entry timestamping: every entry is wrapped as {value, fetched_at} so the
 * runner can prune entries older than a user-configurable threshold via
 * `pruneOlderThan(days)`, then re-fetch. TMDB metadata changes infrequently
 * but does change (year corrections, added seasons, episode title fixes) —
 * without TTL the user has to delete cache files by hand to see updates.
 *
 * Caches are write-through: callers `set()` after a successful API call,
 * then `save()` once at end of run.
 */

import fs from 'fs'

import { writeFileAtomic } from '../core/atomic-write'

import { TimestampedEntry, ValidationCacheFile } from './types'

// ─────────────────────────────────────────────
// Generic JSON cache
// ─────────────────────────────────────────────

export class JsonCache<T> {
  private entries = new Map<string, TimestampedEntry<T>>()

  /**
   * @param cachePath  absolute path to the JSON file on disk
   * @param version    expected schema version — mismatches discard the cache.
   *                   Default 1 keeps backward compatibility for caches that
   *                   were created before the version param existed.
   * @param normalize  optional per-value transform applied as entries load,
   *                   e.g. trimming fields an older version cached. The
   *                   entry's `fetched_at` is kept, so nothing looks fresh.
   */
  constructor(
    private cachePath: string,
    private version: number = 1,
    private normalize?: (value: T) => T
  ) {
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.cachePath)) return

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'))
    } catch (err) {
      console.log(
        `    [CACHE] Corrupt cache at ${this.cachePath} (${(err as Error).message}) — starting fresh`
      )
      return
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('entries' in parsed)
    ) {
      console.log(`    [CACHE] Unexpected shape at ${this.cachePath} — starting fresh`)
      return
    }

    const cf = parsed as ValidationCacheFile<T>
    if (cf.version !== this.version) {
      console.log(
        `    [CACHE] Version mismatch at ${this.cachePath} (${cf.version} vs ${this.version}) — starting fresh`
      )
      return
    }

    for (const [k, v] of Object.entries(cf.entries)) {
      this.entries.set(k, this.normalize ? { ...v, value: this.normalize(v.value) } : v)
    }
  }

  /** Written atomically, so an interrupted run keeps the previous cache. */
  save(): void {
    // Sort keys for stable, diff-friendly output.
    const sortedEntries: Record<string, TimestampedEntry<T>> = {}
    for (const k of [...this.entries.keys()].sort()) {
      sortedEntries[k] = this.entries.get(k)!
    }
    const cf: ValidationCacheFile<T> = {
      version: this.version,
      entries: sortedEntries,
    }
    writeFileAtomic(this.cachePath, JSON.stringify(cf, null, 2))
  }

  /** Return the cached value (or undefined). Timestamp is internal. */
  get(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  /** Store a value, stamping it with the current time. */
  set(key: string, value: T): void {
    this.entries.set(key, { value, fetched_at: new Date().toISOString() })
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  size(): number {
    return this.entries.size
  }

  /**
   * Drop entries whose `fetched_at` timestamp is older than `days` days ago.
   * Returns the number of entries removed. Entries with an unparseable or
   * missing timestamp are treated as old and pruned.
   *
   * Call this BEFORE doing TMDB lookups so the stale ones get re-fetched
   * naturally on cache miss.
   */
  pruneOlderThan(days: number): number {
    if (days <= 0) return 0
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [key, entry] of this.entries) {
      const ts = Date.parse(entry.fetched_at)
      if (!Number.isFinite(ts) || ts < cutoffMs) {
        this.entries.delete(key)
        removed++
      }
    }
    return removed
  }
}

// ─────────────────────────────────────────────
// Search key helper
// ─────────────────────────────────────────────

/**
 * Build the lookup key for the search cache. Title is lowercased and trimmed
 * so case differences ("THE CROW" vs "The Crow") deduplicate. Year is part
 * of the key so a movie with the same title but a different year doesn't
 * collide.
 */
export function searchKey(type: 'movie' | 'show', title: string, year: number): string {
  return `${type}|${title.trim().toLowerCase()}|${year}`
}
