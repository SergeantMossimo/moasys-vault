/**
 * probe/movies.ts
 * ---------------
 * ffprobe pass for movies — walks the library, probes every primary video
 * file (with cache), and writes the per-movie aggregated result.
 *
 * Naming-related warnings (bad file name, year mismatch, etc.) are NOT
 * re-emitted here — those are the scan pass's job. The probe pass only
 * adds probe-specific warnings: quality_mismatch, short_duration, large_file.
 */

import fs from 'fs'
import path from 'path'

import { DirReader } from '../core/dir-reader'
import { MoviesConfig, WarningCollector } from '../core/types'
import { isPrimary, toRel } from '../core/files'
import { MoviesRules } from '../core/rules/movies'
import { compilePattern, resolveCategories } from '../core/rules/helpers'
import { makeKey, parseFileStem } from '../media/movies'

import { ProbeCache } from './cache'
import {
  ProbeTask,
  ProbedFile,
  classifyQuality,
  findOversizedFile,
  formatBitrateAndSize,
  formatBucketRange,
  logProbeProgress,
  probeBatch,
} from './helpers'
import { MovieProbeOutput, FileProbe, ProbeData, ProbeResult } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Human-readable runtime for warning messages — `2m 05s`, `1h 47m 12s`.
 * Module-local on purpose; promote to probe/helpers.ts if a second caller
 * ever needs it.
 */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

/**
 * Walk every configured category and collect probe tasks for all primary
 * video files. Returns the tasks plus the parsed identity for each so the
 * post-probe aggregation can group files by movie without re-parsing.
 */
function collectTasks(
  config: MoviesConfig,
  rules: MoviesRules,
  dir: DirReader
): Array<{
  task: ProbeTask
  identity: { title: string; year: number; edition: string | null }
}> {
  const fileRegex = compilePattern(rules.patterns.file)
  const tasks: Array<{
    task: ProbeTask
    identity: { title: string; year: number; edition: string | null }
  }> = []

  for (const cat of resolveCategories(rules.categories)) {
    const folderPath = path.join(config.root_path, cat.folderName)
    // Missing folders are reported once, by the scan pass (core/scanner.ts).
    if (!dir.isDirectory(folderPath)) continue

    let topEntries: fs.Dirent[]
    try {
      topEntries = dir.readdir(folderPath)
    } catch {
      continue // the scan pass reports it as permission_denied
    }

    for (const movieEntry of topEntries) {
      if (!movieEntry.isDirectory()) continue
      const movieFolderPath = path.join(folderPath, movieEntry.name)

      let files: fs.Dirent[]
      try {
        files = dir.readdir(movieFolderPath)
      } catch {
        continue // Permission errors etc. — scan pass will have already flagged
      }

      for (const f of files) {
        if (!f.isFile()) continue
        if (!isPrimary(f.name, rules.primary_extension)) continue // Only probe primary files

        const stem = path.basename(f.name, path.extname(f.name))
        const parsed = parseFileStem(stem, fileRegex)
        if (!parsed) continue // Unparseable — scan already warned

        const absolutePath = path.join(movieFolderPath, f.name)
        let stat: fs.Stats
        try {
          stat = fs.statSync(absolutePath)
        } catch {
          continue
        }

        tasks.push({
          task: {
            relativePath: toRel(path.join(cat.folderName, movieEntry.name, f.name)),
            absolutePath,
            category: cat.name,
            quality: cat.quality,
            mtime: stat.mtimeMs,
            size: stat.size,
          },
          // An empty `{edition-}` is no edition, as the scan catalogues it.
          identity: { title: parsed.title, year: parsed.year, edition: parsed.edition || null },
        })
      }
    }
  }

  return tasks
}

// ─────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────

interface MovieGroup {
  title: string
  year: number
  edition: string | null
  files: FileProbe[]
}

/**
 * Group probed files by canonical movie key. Each movie's `files` array is
 * sorted by quality folder order so the output matches the scan-side ordering.
 */
function aggregate(
  probed: ProbedFile[],
  identities: Map<string, { title: string; year: number; edition: string | null }>,
  categoryOrder: string[]
): MovieProbeOutput[] {
  const groups = new Map<string, MovieGroup>()

  for (const { task, data } of probed) {
    const ident = identities.get(task.relativePath)
    if (!ident) continue // Defensive — should never happen
    const key = makeKey(ident.title, ident.year, ident.edition)

    let group = groups.get(key)
    if (!group) {
      group = {
        title: ident.title,
        year: ident.year,
        edition: ident.edition,
        files: [],
      }
      groups.set(key, group)
    }

    group.files.push({
      category: task.category,
      path: task.relativePath,
      size_bytes: data.size_bytes,
      duration_seconds: data.duration_seconds,
      bitrate: data.bitrate,
      video: data.video,
      audio: data.audio,
      tags: data.tags,
    })
  }

  // Sort files within each movie by configured quality order, then sort movies
  // by title for stable output.
  const categoryIndex = (c: string) => {
    const i = categoryOrder.indexOf(c)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  for (const group of groups.values()) {
    group.files.sort((a, b) => categoryIndex(a.category) - categoryIndex(b.category))
  }

  return [...groups.values()].sort((a, b) => {
    const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
    if (t !== 0) return t
    if (a.year !== b.year) return a.year - b.year
    return (a.edition ?? '').localeCompare(b.edition ?? '')
  })
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

/**
 * Run the movies probe pass end-to-end.
 *   1. Walk the library and build probe tasks
 *   2. Probe each file (cache-aware), reporting progress
 *   3. Emit quality_mismatch warnings for files outside their bucket
 *   4. Emit short_duration warnings for files at or below the runtime floor
 *   5. Aggregate into the per-movie shape and return
 *
 * Cache writes are the caller's responsibility — keeps this function pure-ish
 * and lets the runner control when the cache is persisted.
 */
export async function probeMovies(
  config: MoviesConfig,
  rules: MoviesRules,
  cache: ProbeCache,
  warnings: WarningCollector,
  dir: DirReader = new DirReader()
): Promise<ProbeResult<MovieProbeOutput[]>> {
  const collected = collectTasks(config, rules, dir)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  // Build a reverse map so aggregation can look up identity by relativePath
  // without re-running the regex.
  const identities = new Map<string, { title: string; year: number; edition: string | null }>()
  for (const { task, identity } of collected) identities.set(task.relativePath, identity)

  const tasks = collected.map(c => c.task)
  const probed = await probeBatch(
    tasks,
    cache,
    logProbeProgress,
    undefined,
    warnings,
    config.probe_concurrency
  )

  // Quality mismatch check — runs after probing so we have real dimensions.
  if (rules.checks.warn_quality_mismatch) {
    for (const { task, data } of probed) {
      if (!data.video) continue // Audio-only files (rare here) — can't classify
      const { bucket, fits } = classifyQuality(
        data.video.width,
        data.video.height,
        task.quality,
        rules.quality_thresholds
      )
      if (bucket !== null && !fits) {
        warnings.add(
          'warn_quality_mismatch',
          task.relativePath,
          `${data.video.width}x${data.video.height} doesn't fit ${bucket.name} ` +
            `(${formatBucketRange(bucket)})` +
            `${task.category === bucket.name ? '' : ` for '${task.category}'`}.`,
          {
            fix:
              `Move the movie to the folder matching its resolution, or replace the file with ` +
              `a better source.`,
          }
        )
      }
    }
  }

  // Short runtime check — the target is a truncated or failed encode. Only
  // primary-extension files are probed at all (see collectTasks), so a short
  // non-primary file isn't covered here; it already fires warn_non_primary.
  if (rules.checks.warn_short_duration && rules.min_duration_minutes > 0) {
    const thresholdSeconds = rules.min_duration_minutes * 60
    for (const { task, data } of probed) {
      // null means we never measured it — unreadable files fire warn_probe_failed.
      if (data.duration_seconds === null) continue
      if (data.duration_seconds > thresholdSeconds) continue
      warnings.add(
        'warn_short_duration',
        task.relativePath,
        `Runs ${formatDuration(data.duration_seconds)}, at or under the ` +
          `${rules.min_duration_minutes}-minute min_duration_minutes threshold.`,
        {
          fix:
            `Usually a truncated or failed encode — play it to the end and re-encode from ` +
            `source if it is cut short. Expected on short films, TV specials and stand-up sets.`,
        }
      )
    }
  }

  // Large file check — bitrate against the ceiling of the quality the file
  // actually is. Silent for any quality without a max_mbps.
  if (rules.checks.warn_large_file) {
    for (const { task, data } of probed) {
      const over = findOversizedFile(data, rules.quality_thresholds)
      if (over === null) continue
      warnings.add(
        'warn_large_file',
        task.relativePath,
        `${formatBitrateAndSize(over.mbps, data.size_bytes)}, over the ${over.bucket.name} ` +
          `limit of ${over.bucket.max_mbps} Mbps.`,
        {
          fix:
            `Re-encode, or replace it with a smaller copy. Raise max_mbps in ` +
            `rules/movies.local.yaml if this is a bitrate you're happy to keep.`,
        }
      )
    }
  }

  const categoryOrder = resolveCategories(rules.categories).map(c => c.name)
  const byPath = new Map<string, ProbeData>()
  for (const { task, data } of probed) byPath.set(task.relativePath, data)

  return { output: aggregate(probed, identities, categoryOrder), byPath }
}
