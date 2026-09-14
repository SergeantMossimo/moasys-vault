/**
 * probe/movies.ts
 * ---------------
 * ffprobe pass for movies — walks the library, probes every primary video
 * file (with cache), and writes the per-movie aggregated result.
 *
 * Naming-related warnings (bad file name, year mismatch, etc.) are NOT
 * re-emitted here — those are the scan pass's job. The probe pass only
 * adds probe-specific warnings (currently: quality_mismatch, short_duration).
 */

import fs from 'fs'
import path from 'path'

import { MoviesConfig, WarningCollector } from '../core/types'
import { isPrimary } from '../core/files'
import { MoviesRules } from '../core/rules/movies'
import { compilePattern, resolveCategories } from '../core/rules/helpers'

import { ProbeCache } from './cache'
import { ProbeTask, ProbedFile, classifyQuality, probeBatch } from './helpers'
import { MovieProbeOutput, FileProbe, ProbeData, ProbeResult } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Parse a movie file stem to extract title / year / edition.
 * Mirrors the scan-side parser but returns only what the probe needs to key
 * a file. Files that fail to parse are skipped silently — the scan pass has
 * already flagged them.
 */
function parseFileStem(
  stem: string,
  regex: RegExp
): { title: string; year: number; edition: string | null } | null {
  const m = regex.exec(stem)
  if (!m?.groups) return null
  const { title, year, edition: editionRaw } = m.groups
  if (title === undefined || year === undefined) return null
  let edition: string | null
  if (editionRaw === undefined) edition = null
  else if (editionRaw.trim() === '')
    edition = null // Empty {edition-} treated as none, same as scan
  else edition = editionRaw.trim()
  return { title: title.trim(), year: parseInt(year, 10), edition }
}

/** Canonical movie key — title|year|edition, lowercased. Matches scan output. */
function makeKey(title: string, year: number, edition: string | null): string {
  return `${title.toLowerCase()}|${year}|${(edition ?? '').toLowerCase()}`
}

/** Normalize a relative path to forward slashes for cache/output consistency. */
function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

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
  rules: MoviesRules
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
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue

    for (const movieEntry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!movieEntry.isDirectory()) continue
      const movieFolderPath = path.join(folderPath, movieEntry.name)

      let files: fs.Dirent[]
      try {
        files = fs.readdirSync(movieFolderPath, { withFileTypes: true })
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
          identity: parsed,
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
  qualityOrder: string[]
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
      quality: task.category,
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
  const qIndex = (q: string) => {
    const i = qualityOrder.indexOf(q)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  for (const group of groups.values()) {
    group.files.sort((a, b) => qIndex(a.quality) - qIndex(b.quality))
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
  warnings: WarningCollector
): Promise<ProbeResult<MovieProbeOutput[]>> {
  const collected = collectTasks(config, rules)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  // Build a reverse map so aggregation can look up identity by relativePath
  // without re-running the regex.
  const identities = new Map<string, { title: string; year: number; edition: string | null }>()
  for (const { task, identity } of collected) identities.set(task.relativePath, identity)

  const tasks = collected.map(c => c.task)
  const probed = await probeBatch(
    tasks,
    cache,
    (done, total, cached) => {
      if (done === total || done % 100 === 0) {
        console.log(`    [PROBE] ${done}/${total} (${cached} cached)`)
      }
    },
    undefined,
    warnings,
    config.probe_concurrency
  )

  // Quality mismatch check — runs after probing so we have real dimensions.
  if (rules.checks.warn_quality_mismatch) {
    for (const { task, data } of probed) {
      if (!data.video) continue // Audio-only files (rare here) — can't classify
      const { bucket, longEdge, fits } = classifyQuality(
        data.video.width,
        data.video.height,
        task.quality,
        rules.quality_thresholds
      )
      if (bucket !== null && !fits) {
        warnings.add(
          'warn_quality_mismatch',
          task.relativePath,
          `Quality mismatch — ${data.video.width}x${data.video.height} (long edge ${longEdge}px) ` +
            `doesn't fit bucket '${bucket.name}' (` +
            `${bucket.min_width !== undefined ? `min ${bucket.min_width}` : 'no min'}, ` +
            `${bucket.max_width !== undefined ? `max ${bucket.max_width}` : 'no max'}` +
            `) for quality '${task.quality}' (category '${task.category}')`
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
        `Short runtime — ${formatDuration(data.duration_seconds)}, at or below the ` +
          `${rules.min_duration_minutes}-minute threshold (min_duration_minutes). ` +
          `Usually a truncated or failed encode; play the file through to the end and ` +
          `re-encode from source if it's cut short. If it's a genuine short film, TV ` +
          `special, or stand-up set, list the movie under \`movies:\` in ` +
          `ignored/<drive>/movies.yaml`
      )
    }
  }

  const qualityOrder = resolveCategories(rules.categories).map(c => c.name)
  const byPath = new Map<string, ProbeData>()
  for (const { task, data } of probed) byPath.set(task.relativePath, data)

  return { output: aggregate(probed, identities, qualityOrder), byPath }
}
