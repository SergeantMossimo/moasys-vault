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
 *   cache/<drive>/<mediaType>-probe.json  (gitignored)
 *
 * Path normalization:
 *   Stored paths are relative to root_path and use forward slashes — so a
 *   cache built on Windows stays valid if the library is later mounted on
 *   macOS or Linux against the same files.
 */

import fs from 'fs'
import path from 'path'

import { writeFileAtomic } from '../core/atomic-write'
import { toRel } from '../core/files'

import { CacheEntry, CacheFile, CACHE_VERSION, ProbeData } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Build the lookup key for an entry. */
function makeKey(relativePath: string, mtime: number, size: number): string {
  return `${toRel(relativePath)}|${mtime}|${size}`
}

/**
 * The same key with the path case-folded. Windows filesystems (NTFS, exFAT,
 * SMB shares) don't distinguish case, so a case-only rename leaves the file —
 * and its mtime and size — untouched; this is how the cache recognizes it.
 */
function foldedKey(relativePath: string, mtime: number, size: number): string {
  return makeKey(relativePath.toLowerCase(), mtime, size)
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
  /** Case-folded key → exact key, for recognizing a case-only rename. */
  private folded = new Map<string, string>()
  /** Keys read or written this run — the current version of every file probed. */
  private touched = new Set<string>()

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

    for (const e of cf.entries) this.put(e)
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

  /** Index an entry under its exact and case-folded keys. */
  private put(entry: CacheEntry): string {
    const key = makeKey(entry.path, entry.mtime, entry.size)
    const foldKey = foldedKey(entry.path, entry.mtime, entry.size)
    // A different-case entry for the same file is the pre-rename spelling.
    const previous = this.folded.get(foldKey)
    if (previous !== undefined && previous !== key) this.entries.delete(previous)
    this.entries.set(key, entry)
    this.folded.set(foldKey, key)
    return key
  }

  /**
   * Look up cached probe data for a file. Returns null if not cached or if
   * mtime/size have changed since the entry was written.
   *
   * A file whose name changed only in case (a tidy-up rename) is still found,
   * and its entry moves to the new spelling, rather than costing a re-probe.
   */
  get(relativePath: string, mtime: number, size: number): ProbeData | null {
    const key = makeKey(relativePath, mtime, size)
    let entry = this.entries.get(key)
    if (!entry) {
      const previous = this.folded.get(foldedKey(toRel(relativePath), mtime, size))
      const renamed = previous !== undefined ? this.entries.get(previous) : undefined
      if (!renamed) return null
      entry = { ...renamed, path: toRel(relativePath) }
      this.put(entry)
    }
    this.touched.add(key)
    return entry.data
  }

  /** Store a fresh probe result. Overwrites any existing entry at the same key. */
  set(relativePath: string, mtime: number, size: number, data: ProbeData): void {
    this.touched.add(this.put({ path: toRel(relativePath), mtime, size, data }))
  }

  /** Total entries currently in cache. Useful for run summaries. */
  size(): number {
    return this.entries.size
  }

  /**
   * Drop entries that can never be read again. Returns the number removed.
   *
   * Two kinds go:
   *
   *   - Superseded versions: the file was read this run under a different
   *     mtime or size (it was re-tagged, re-encoded, or replaced), so the
   *     entry for its old mtime/size is dead. Without this a cache grows by
   *     one entry per file every time a library is re-tagged.
   *   - Orphans: the file no longer exists under `rootPath`. Existence is
   *     checked on disk.
   *
   * Safe to call at the end of a scan: nothing removed was read this run.
   *
   * Refuses to prune anything when `rootPath` itself is missing — an
   * unplugged drive or a moved folder would otherwise look like a library
   * where every file was deleted, and wipe a cache that takes minutes to
   * rebuild. Entries under `keepPrefixes` (forward-slash relative folders,
   * e.g. category folders that are missing this run) are kept for the same
   * reason.
   *
   * `seenThisRun` is the set of relative paths the probe pass just found on
   * disk. Those are known to exist, so only the remaining entries are checked
   * — on a network share that turns one existence check per cached file into
   * one per file that actually went away. The result is identical either way.
   */
  pruneOrphans(
    rootPath: string,
    keepPrefixes: string[] = [],
    seenThisRun: ReadonlySet<string> = new Set()
  ): number {
    if (!fs.existsSync(rootPath)) return 0
    const keep = keepPrefixes.map(p => (p.endsWith('/') ? p : `${p}/`).toLowerCase())

    const touchedPaths = new Set(
      [...this.touched].map(key => this.entries.get(key)?.path.toLowerCase())
    )

    let removed = 0
    for (const [key, entry] of this.entries) {
      if (!this.touched.has(key) && touchedPaths.has(entry.path.toLowerCase())) {
        this.remove(key, entry)
        removed++
        continue
      }
      if (seenThisRun.has(entry.path)) continue
      const lower = entry.path.toLowerCase()
      if (keep.some(prefix => lower.startsWith(prefix))) continue
      const absolutePath = path.join(rootPath, entry.path)
      if (!fs.existsSync(absolutePath)) {
        this.remove(key, entry)
        removed++
      }
    }
    return removed
  }

  private remove(key: string, entry: CacheEntry): void {
    this.entries.delete(key)
    const foldKey = foldedKey(entry.path, entry.mtime, entry.size)
    if (this.folded.get(foldKey) === key) this.folded.delete(foldKey)
  }
}
