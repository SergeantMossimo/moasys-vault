/**
 * probe/cache.ts
 * --------------
 * Persistent ffprobe cache keyed by (relative path, mtime, size).
 *
 * Rationale:
 *   ffprobe is fast per-file (~50-200ms) but a library with thousands of
 *   files is slow in aggregate. Most of the time, files haven't changed —
 *   so we cache the probe result and re-probe only when mtime or size
 *   differs from the cached entry.
 *
 * Cache location:
 *   cache/<mediaType>-probe.json  (gitignored)
 *
 * Path normalization:
 *   Stored paths are relative to root_path and use forward slashes — so a
 *   cache built on Windows stays valid if the library is later mounted on
 *   macOS or Linux against the same files.
 */

import fs from 'fs'
import path from 'path'

import { writeFileAtomic } from '../core/atomic-write'

import { CacheEntry, CacheFile, CACHE_VERSION, ProbeData } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Normalize a path for cache key use — relative, forward slashes. */
function normalize(p: string): string {
  return p.split(path.sep).join('/')
}

/** Build the lookup key for an entry. */
function makeKey(relativePath: string, mtime: number, size: number): string {
  return `${normalize(relativePath)}|${mtime}|${size}`
}

// ─────────────────────────────────────────────
// ProbeCache
// ─────────────────────────────────────────────

/**
 * In-memory cache backed by a JSON file. Load at start, save at end.
 *
 * Orphan cleanup is opt-in via `pruneOrphans()` — call it after the probe
 * pass to drop entries whose underlying files no longer exist. Without
 * pruning, orphan entries are harmless but accumulate over time as files
 * are renamed or deleted from the library.
 */
export class ProbeCache {
  private entries = new Map<string, CacheEntry>()

  constructor(private cachePath: string) {
    this.load()
  }

  /** Load cache from disk. Silently ignores missing files (first run). */
  private load(): void {
    if (!fs.existsSync(this.cachePath)) return

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'))
    } catch (err) {
      console.log(
        `    [CACHE] Corrupt cache file at ${this.cachePath} (${(err as Error).message}) — starting fresh`
      )
      return
    }

    // Validate the on-disk shape. Cache schema mismatches are not fatal —
    // we just discard the old cache and rebuild. Beats failing the whole run.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('entries' in parsed)
    ) {
      console.log(
        `    [CACHE] Cache file at ${this.cachePath} has unexpected shape — starting fresh`
      )
      return
    }
    const cf = parsed as CacheFile
    if (cf.version !== CACHE_VERSION) {
      console.log(
        `    [CACHE] Cache version mismatch (${cf.version} vs ${CACHE_VERSION}) — starting fresh`
      )
      return
    }

    for (const e of cf.entries) {
      this.entries.set(makeKey(e.path, e.mtime, e.size), e)
    }
  }

  /**
   * Save the cache to disk. Creates parent directory if needed. Written
   * atomically — a run interrupted mid-save keeps the previous cache instead
   * of leaving a truncated file that would force a full re-probe.
   */
  save(): void {
    const cf: CacheFile = {
      version: CACHE_VERSION,
      entries: [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    }
    writeFileAtomic(this.cachePath, JSON.stringify(cf, null, 2))
  }

  /**
   * Look up cached probe data for a file. Returns null if not cached or if
   * mtime/size have changed since the entry was written.
   */
  get(relativePath: string, mtime: number, size: number): ProbeData | null {
    const entry = this.entries.get(makeKey(relativePath, mtime, size))
    return entry ? entry.data : null
  }

  /** Store a fresh probe result. Overwrites any existing entry at the same key. */
  set(relativePath: string, mtime: number, size: number, data: ProbeData): void {
    const normalized = normalize(relativePath)
    this.entries.set(makeKey(normalized, mtime, size), {
      path: normalized,
      mtime,
      size,
      data,
    })
  }

  /** Total entries currently in cache. Useful for run summaries. */
  size(): number {
    return this.entries.size
  }

  /**
   * Drop entries whose underlying file no longer exists under `rootPath`.
   * Returns the number of entries removed.
   *
   * Resolves each entry's stored relative path against `rootPath` and checks
   * the filesystem. Existence-only — no mtime/size re-check, since changed
   * files already invalidate via the cache key on lookup.
   *
   * Safe to call at the end of a scan: cleared entries weren't read this run
   * (their files don't exist), so dropping them doesn't lose any work.
   */
  pruneOrphans(rootPath: string): number {
    let removed = 0
    for (const [key, entry] of this.entries) {
      const absolutePath = path.join(rootPath, entry.path)
      if (!fs.existsSync(absolutePath)) {
        this.entries.delete(key)
        removed++
      }
    }
    return removed
  }
}
