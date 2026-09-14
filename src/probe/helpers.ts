/**
 * probe/helpers.ts
 * ----------------
 * Shared helpers used by every per-media-type probe module.
 *
 * Provides:
 *   - probeOrCache(): single-file probe that consults the cache first
 *   - probeBatch(): runs a list of probe tasks with progress, optionally in parallel
 *   - classifyQuality(): maps a file's dimensions to a quality_thresholds bucket
 *     and reports whether it fits the folder's expected bucket
 *
 * Probing is sequential by default. ffprobe is mostly disk-bound, and on
 * spinning rust parallelism can thrash seeks. SSDs and network shares handle
 * parallel reads well, so each root can opt in with `probe_concurrency` in
 * config.json. Cached runs are basically instant either way — this only
 * changes how long a first scan takes.
 */

import { WarningCollector } from '../core/types'

import { probeFile } from './ffprobe'
import { ProbeCache } from './cache'
import { ProbeData, TagData } from './types'

// ─────────────────────────────────────────────
// Probe tasks
// ─────────────────────────────────────────────

/**
 * One file to probe, with everything needed for caching and downstream use.
 * Path fields are split so we cache by the cross-platform relative form but
 * spawn ffprobe with the absolute one.
 */
export interface ProbeTask {
  /** Path relative to the media root, e.g. "UHD/The Crow (1994)/The Crow (1994).mp4" */
  relativePath: string
  /** Absolute path used to spawn ffprobe */
  absolutePath: string
  /** Category label (folder name, or "default") — surfaced in probe.json output */
  category: string
  /**
   * Auto-detected quality keyword for this category (UHD/HD/SD), or null
   * when the category name doesn't include one. Used by `classifyQuality`
   * for the warn_quality_mismatch check. Null means "general tag — skip
   * the check."
   */
  quality: string | null
  /** File mtime in ms (cache key) */
  mtime: number
  /** File size in bytes (cache key) */
  size: number
}

/** A probe task and its result, paired for downstream aggregation. */
export interface ProbedFile {
  task: ProbeTask
  data: ProbeData
}

// ─────────────────────────────────────────────
// Probing
// ─────────────────────────────────────────────

/**
 * Optional async reader for embedded tag data. Music probe passes one in to
 * also capture ID3 / Vorbis comment / MP4 tags during the same walk.
 * The audiobooks probe does the same, to compare album/artist tags against
 * book/author folders. Movies and shows skip this.
 */
export type TagReader = (absolutePath: string) => Promise<TagData | null>

/**
 * Return cached probe data when fresh, otherwise spawn ffprobe and cache the result.
 * If `readTags` is provided, also populate ProbeData.tags from the same file.
 * Errors propagate — callers decide whether to warn or abort.
 */
export async function probeOrCache(
  task: ProbeTask,
  cache: ProbeCache,
  readTags?: TagReader
): Promise<ProbeData> {
  const cached = cache.get(task.relativePath, task.mtime, task.size)
  if (cached) {
    // Backfill tags onto an entry cached before this pass read them — a tag
    // read is a header parse, far cheaper than re-running ffprobe. Entries
    // that already carry tags count as read even without the flag, so a
    // music cache written before `tags_read` existed isn't re-read.
    if (readTags && !cached.tags_read && cached.tags === null) {
      cached.tags = await readTags(task.absolutePath)
      cached.tags_read = true
      cache.set(task.relativePath, task.mtime, task.size, cached)
    }
    return cached
  }
  const data = await probeFile(task.absolutePath)
  if (readTags) {
    data.tags = await readTags(task.absolutePath)
    data.tags_read = true
  }
  cache.set(task.relativePath, task.mtime, task.size, data)
  return data
}

/**
 * Probe a list of files sequentially, reporting progress via callback.
 * Individual file errors are swallowed and logged — one corrupt file
 * shouldn't take down a whole library scan. Failed files are excluded
 * from the returned results.
 *
 * Pass a `readTags` callback when the caller wants embedded metadata
 * captured alongside the ffprobe data (music and audiobooks probes use this).
 * Cached entries that were never tag-read get their tags backfilled.
 *
 * Pass `warnings` so failures reach warnings.json as `warn_probe_failed`
 * rather than only the console. A file ffprobe can't read is usually a file
 * a PLAYER can't read either — the failure that prompted this check was an
 * .mp4 whose moov atom was never written and whose data was 81% zero-fill,
 * so it was unplayable in Plex too. Console-only reporting meant the catalog
 * still listed it as a normal episode and warnings.json said nothing, so the
 * one genuinely broken file in a library was the one the hygiene scanner was
 * silent about.
 *
 * Like `permission_denied`, this has no rules toggle: it reports a file the
 * scanner physically could not read, not a naming preference. Silence it per
 * path via `ignored/<drive>/<type>.yaml` if a known-bad file is intentional.
 */
export async function probeBatch(
  tasks: ProbeTask[],
  cache: ProbeCache,
  onProgress?: (done: number, total: number, cached: number) => void,
  readTags?: TagReader,
  warnings?: WarningCollector,
  concurrency = 1
): Promise<ProbedFile[]> {
  // Indexed by task so results come back in input order however the probes
  // interleave — catalog and probe.json output stay deterministic.
  const results: Array<ProbedFile | undefined> = new Array(tasks.length)
  let cachedCount = 0
  let done = 0
  let next = 0

  const probeOne = async (i: number): Promise<void> => {
    const task = tasks[i]!
    try {
      // Detect cache hit before calling probeOrCache so we can count it.
      const wasCached = cache.get(task.relativePath, task.mtime, task.size) !== null
      const data = await probeOrCache(task, cache, readTags)
      if (wasCached) cachedCount++
      results[i] = { task, data }
    } catch (err) {
      const message = (err as Error).message
      console.error(`    [PROBE] Failed: ${task.relativePath} — ${message}`)
      warnings?.add(
        'warn_probe_failed',
        task.relativePath,
        `ffprobe could not read this file: ${message.trim()} ` +
          `The file is excluded from probe output and has no quality data. ` +
          `A file ffprobe rejects is usually unplayable in Plex too — verify it plays, ` +
          `and re-copy it from your source if it doesn't.`
      )
    }
    onProgress?.(++done, tasks.length, cachedCount)
  }

  // A small pool of workers pulling the next index. With concurrency 1 this
  // is exactly the old sequential loop.
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await probeOne(next++)
  }
  const workers = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: workers }, worker))

  return results.filter((r): r is ProbedFile => r !== undefined)
}

// ─────────────────────────────────────────────
// Quality classification
// ─────────────────────────────────────────────

/**
 * Shape of one quality_threshold bucket in the rules.
 * Replicated here as a structural interface so this module doesn't have to
 * import from src/core/rules — both rules schemas (movies and shows) use
 * the same bucket shape, and we only consume three fields.
 */
export interface QualityBucket {
  name: string
  min_width?: number
  max_width?: number
}

/**
 * Result of checking one file's dimensions against the quality bucket
 * whose name matches the file's category.
 *
 * `bucket` is null when no bucket matches the category (we silently pass).
 * `fits` indicates whether the file's long edge falls in the bucket's range.
 * The caller decides whether `!fits` should emit a warning.
 */
export interface QualityClassification {
  bucket: QualityBucket | null
  longEdge: number
  fits: boolean
}

/** Find the quality bucket whose name matches the quality, or null. */
function findBucket(quality: string | null, buckets: QualityBucket[]): QualityBucket | null {
  if (quality === null) return null
  return buckets.find(b => b.name === quality) ?? null
}

/**
 * Check a video file's dimensions against the quality bucket for the quality
 * its category auto-detected to. Returns silent-pass when `quality` is null
 * (general-tag category) or when no bucket matches the quality name.
 *
 * Uses the long edge (max of width and height) so a rotated or unusually
 * shaped file is classified by its largest dimension — a 1080x1920 vertical
 * file still counts as HD.
 *
 * Cropped HandBrake outputs work too: a 664x448 SD file has a long edge of
 * 664, well under the typical SD max_width of 1000.
 */
export function classifyQuality(
  width: number,
  height: number,
  quality: string | null,
  buckets: QualityBucket[]
): QualityClassification {
  const bucket = findBucket(quality, buckets)
  const longEdge = Math.max(width, height)

  if (bucket === null) {
    return { bucket: null, longEdge, fits: true }
  }

  const overMin = bucket.min_width === undefined || longEdge >= bucket.min_width
  const underMax = bucket.max_width === undefined || longEdge <= bucket.max_width

  return { bucket, longEdge, fits: overMin && underMax }
}

/**
 * Derive a quality label by finding the first bucket whose dimension range
 * contains the file's long edge. Independent of category — answers the
 * question "what quality IS this file?" rather than "does this file fit
 * its category's expected quality?" (`classifyQuality` answers the latter).
 *
 * Returns null when no bucket's range matches, or when quality_thresholds
 * is empty. Buckets are scanned in declaration order, so put narrower
 * ranges first if any might overlap.
 */
export function deriveQuality(
  width: number,
  height: number,
  buckets: QualityBucket[]
): string | null {
  const longEdge = Math.max(width, height)
  for (const bucket of buckets) {
    const overMin = bucket.min_width === undefined || longEdge >= bucket.min_width
    const underMax = bucket.max_width === undefined || longEdge <= bucket.max_width
    if (overMin && underMax) return bucket.name
  }
  return null
}
