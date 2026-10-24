/**
 * probe/shows.ts
 * --------------
 * ffprobe pass for shows — walks the library, probes every primary episode
 * file (with cache), and writes the per-show/per-season aggregated result.
 *
 * Naming warnings are not re-emitted here — the scan pass handles those.
 * The probe pass only adds quality_mismatch and large_file warnings, one row
 * per season.
 */

import fs from 'fs'
import path from 'path'

import { DirReader } from '../core/dir-reader'
import { ShowsConfig, WarningCollector } from '../core/types'
import { isPrimary, toRel } from '../core/files'
import { ShowsRules } from '../core/rules/shows'
import { compilePattern, resolveCategories } from '../core/rules/helpers'

import { listWithMore } from '../core/gaps'
import {
  makeShowKey,
  parseFileStem,
  parseSeasonFolder,
  parseShowFolder,
  seasonSortKey,
} from '../media/shows'
import { ProbeCache } from './cache'
import {
  ProbeTask,
  ProbedFile,
  QualityBucket,
  classifyQuality,
  deriveQuality,
  findOversizedFile,
  formatBitrateAndSize,
  formatBucketRange,
  logProbeProgress,
  probeBatch,
} from './helpers'
import { ShowProbeOutput, ShowSeasonProbe, EpisodeProbe, ProbeData, ProbeResult } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

interface ShowIdentity {
  title: string
  year: number
  /** Plex's TV Show Editions tag, or null when the folder carries none. */
  edition: string | null
}

interface EpisodeIdentity {
  show: ShowIdentity
  seasonLabel: string // "1", "Specials", etc.
  episodeId: string // "S01E01" or "S01E01-E02"
}

/** Order episode codes by their numbers, so `S01E99` sorts before `S01E100`. */
export const byEpisodeCode = new Intl.Collator('en', { numeric: true }).compare

function formatEpisodeId(season: number, first: number, last: number): string {
  const s = String(season).padStart(2, '0')
  const e1 = String(first).padStart(2, '0')
  if (last === first) return `S${s}E${e1}`
  const e2 = String(last).padStart(2, '0')
  return `S${s}E${e1}-E${e2}`
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

function collectTasks(
  config: ShowsConfig,
  rules: ShowsRules,
  dir: DirReader
): Array<{ task: ProbeTask; identity: EpisodeIdentity }> {
  const showFolderRegex = compilePattern(rules.patterns.show_folder)
  const seasonFolderRegex = compilePattern(rules.patterns.season_folder)
  const fileRegex = compilePattern(rules.patterns.file)
  const ignoredLower = rules.ignored_season_names.map(n => n.toLowerCase())

  const out: Array<{ task: ProbeTask; identity: EpisodeIdentity }> = []

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

    for (const showEntry of topEntries) {
      if (!showEntry.isDirectory()) continue
      const parsedShow = parseShowFolder(showEntry.name, showFolderRegex)
      if (!parsedShow) continue // Scan pass already warned
      // An empty `{edition-}` is no edition, as the scan catalogues it.
      const show: ShowIdentity = {
        title: parsedShow.title,
        year: parsedShow.year,
        edition: parsedShow.edition || null,
      }

      const showPath = path.join(folderPath, showEntry.name)
      let seasonEntries: fs.Dirent[]
      try {
        seasonEntries = dir.readdir(showPath)
      } catch {
        continue
      }

      for (const seasonEntry of seasonEntries) {
        if (!seasonEntry.isDirectory()) continue
        let seasonLabel: string
        if (ignoredLower.includes(seasonEntry.name.toLowerCase())) {
          seasonLabel = seasonEntry.name
        } else {
          const n = parseSeasonFolder(seasonEntry.name, seasonFolderRegex)
          if (n === null) continue
          seasonLabel = String(n)
        }

        const seasonPath = path.join(showPath, seasonEntry.name)
        let files: fs.Dirent[]
        try {
          files = dir.readdir(seasonPath)
        } catch {
          continue
        }

        for (const f of files) {
          if (!f.isFile()) continue
          if (!isPrimary(f.name, rules.primary_extension)) continue
          const stem = path.basename(f.name, path.extname(f.name))
          const parsed = parseFileStem(stem, fileRegex)
          if (!parsed) continue

          const absolutePath = path.join(seasonPath, f.name)
          let stat: fs.Stats
          try {
            stat = fs.statSync(absolutePath)
          } catch {
            continue
          }

          out.push({
            task: {
              relativePath: toRel(
                path.join(cat.folderName, showEntry.name, seasonEntry.name, f.name)
              ),
              absolutePath,
              category: cat.name,
              quality: cat.quality,
              mtime: stat.mtimeMs,
              size: stat.size,
            },
            identity: {
              show,
              seasonLabel,
              episodeId: formatEpisodeId(parsed.season, parsed.firstEpisode, parsed.lastEpisode),
            },
          })
        }
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────

function aggregate(
  probed: ProbedFile[],
  identities: Map<string, EpisodeIdentity>,
  categoryOrder: string[]
): ShowProbeOutput[] {
  const shows = new Map<
    string,
    {
      title: string
      year: number
      edition: string | null
      seasons: Map<string, EpisodeProbe[]>
    }
  >()

  for (const { task, data } of probed) {
    const id = identities.get(task.relativePath)
    if (!id) continue

    const key = makeShowKey(id.show.title, id.show.year, id.show.edition)
    let show = shows.get(key)
    if (!show) {
      show = {
        title: id.show.title,
        year: id.show.year,
        edition: id.show.edition,
        seasons: new Map(),
      }
      shows.set(key, show)
    }
    let seasonEps = show.seasons.get(id.seasonLabel)
    if (!seasonEps) {
      seasonEps = []
      show.seasons.set(id.seasonLabel, seasonEps)
    }
    seasonEps.push({
      category: task.category,
      path: task.relativePath,
      episode: id.episodeId,
      size_bytes: data.size_bytes,
      duration_seconds: data.duration_seconds,
      bitrate: data.bitrate,
      video: data.video,
      audio: data.audio,
      tags: data.tags,
    })
  }

  const categoryIndex = (c: string) => {
    const i = categoryOrder.indexOf(c)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }

  return [...shows.values()]
    .sort((a, b) => {
      const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
      if (t !== 0) return t
      if (a.year !== b.year) return a.year - b.year
      return (a.edition ?? '').toLowerCase().localeCompare((b.edition ?? '').toLowerCase())
    })
    .map(show => {
      const seasons: ShowSeasonProbe[] = [...show.seasons.entries()]
        .sort(([a], [b]) => {
          const [ag0, ag1, as2] = seasonSortKey(a)
          const [bg0, bg1, bs2] = seasonSortKey(b)
          if (ag0 !== bg0) return ag0 - bg0
          if (ag1 !== bg1) return ag1 - bg1
          return as2.localeCompare(bs2)
        })
        .map(([season, episodes]) => ({
          season,
          episodes: episodes.sort((a, b) => {
            // Sort by episode id (numerically, so S01E99 precedes S01E100), then category
            if (a.episode !== b.episode) return byEpisodeCode(a.episode, b.episode)
            return categoryIndex(a.category) - categoryIndex(b.category)
          }),
        }))
      return { title: show.title, year: show.year, edition: show.edition, seasons }
    })
}

// ─────────────────────────────────────────────
// Quality mismatch
// ─────────────────────────────────────────────

/** How many resolutions and episode codes a season summary spells out. */
const QUALITY_SAMPLE_LIMIT = 3

/**
 * `warn_quality_mismatch`, summarized once per season folder — like
 * warn_missing_episode_title and warn_episode_code_case. A season that's in
 * the wrong quality folder is wrong wholesale, and one row per episode buried
 * the signal: a single external drive produced 7,346 of them.
 *
 * The summary says how many episodes miss the bucket, which resolutions they
 * are and which bucket each actually fits (so you know where the season
 * belongs), and a few episode codes.
 */
function reportQualityMismatches(
  probed: ProbedFile[],
  identities: Map<string, EpisodeIdentity>,
  rules: ShowsRules,
  warnings: WarningCollector
): void {
  interface SeasonTally {
    total: number
    category: string
    quality: string | null
    bucket: QualityBucket | null
    misses: Array<{ episodeId: string; dims: string }>
  }
  const seasons = new Map<string, SeasonTally>()

  for (const { task, data } of probed) {
    if (!data.video) continue
    const seasonFolder = path.posix.dirname(task.relativePath)
    let tally = seasons.get(seasonFolder)
    if (!tally) {
      tally = { total: 0, category: task.category, quality: task.quality, bucket: null, misses: [] }
      seasons.set(seasonFolder, tally)
    }
    tally.total++

    const { bucket, fits } = classifyQuality(
      data.video.width,
      data.video.height,
      task.quality,
      rules.quality_thresholds
    )
    if (bucket === null || fits) continue
    // An `episodes:` entry can't reach the season row below, so honor it here.
    if (warnings.isIgnored(task.relativePath)) continue
    tally.bucket = bucket
    tally.misses.push({
      episodeId:
        identities.get(task.relativePath)?.episodeId ?? path.posix.basename(task.relativePath),
      dims: `${data.video.width}x${data.video.height}`,
    })
  }

  for (const [seasonFolder, tally] of seasons) {
    const bucket = tally.bucket
    if (bucket === null || tally.misses.length === 0) continue

    const byDims = new Map<string, number>()
    for (const miss of tally.misses) byDims.set(miss.dims, (byDims.get(miss.dims) ?? 0) + 1)
    const dims = [...byDims.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const dimsText = listWithMore(
      dims.map(([d, n]) => {
        const [w, h] = d.split('x').map(Number)
        const fitsQuality = deriveQuality(w!, h!, rules.quality_thresholds)
        return `${d}${fitsQuality ? ` (fits ${fitsQuality})` : ''} ×${n}`
      }),
      QUALITY_SAMPLE_LIMIT
    )

    const codes = tally.misses.map(m => m.episodeId).sort(byEpisodeCode)
    const codesText = listWithMore(codes, QUALITY_SAMPLE_LIMIT)

    // Name the category only when it isn't simply the bucket (`Other HD` → HD).
    const from = tally.category === bucket.name ? '' : ` for '${tally.category}'`

    warnings.add(
      'warn_quality_mismatch',
      seasonFolder,
      `${tally.misses.length}/${tally.total} episodes are ${dimsText}, not ` +
        `${bucket.name} (${formatBucketRange(bucket)})${from}. ${codesText}.`,
      {
        fix:
          `Move the season to the folder matching its resolution, or replace the files with ` +
          `a better source.`,
      }
    )
  }
}

/**
 * `warn_large_file`, summarized once per season folder like
 * `warn_quality_mismatch`: a season ripped or downloaded at a high bitrate
 * usually is wholesale. Leads with how many episodes are over, then the
 * largest few by bitrate — the ones worth replacing first.
 */
function reportLargeFiles(
  probed: ProbedFile[],
  identities: Map<string, EpisodeIdentity>,
  rules: ShowsRules,
  warnings: WarningCollector
): void {
  interface SeasonTally {
    total: number
    over: Array<{ episodeId: string; mbps: number; size: number; quality: string; limit: number }>
  }
  const seasons = new Map<string, SeasonTally>()

  for (const { task, data } of probed) {
    if (!data.video) continue
    const seasonFolder = path.posix.dirname(task.relativePath)
    const tally = seasons.get(seasonFolder) ?? { total: 0, over: [] }
    seasons.set(seasonFolder, tally)
    tally.total++

    const over = findOversizedFile(data, rules.quality_thresholds)
    if (over === null) continue
    // An `episodes:` entry can't reach the season row below, so honor it here.
    if (warnings.isIgnored(task.relativePath)) continue
    tally.over.push({
      episodeId:
        identities.get(task.relativePath)?.episodeId ?? path.posix.basename(task.relativePath),
      mbps: over.mbps,
      size: data.size_bytes,
      quality: over.bucket.name,
      limit: over.bucket.max_mbps,
    })
  }

  for (const [seasonFolder, tally] of seasons) {
    if (tally.over.length === 0) continue
    const largest = [...tally.over].sort((a, b) => b.mbps - a.mbps)
    const shown = listWithMore(
      largest.map(o => `${o.episodeId} ${formatBitrateAndSize(o.mbps, o.size)}`),
      QUALITY_SAMPLE_LIMIT
    )
    // A season is almost always one quality; name each limit when it isn't.
    const limits = [...new Set(tally.over.map(o => `${o.quality} limit of ${o.limit} Mbps`))]

    warnings.add(
      'warn_large_file',
      seasonFolder,
      `${tally.over.length}/${tally.total} episodes over the ${limits.join(' / ')}: ` + `${shown}.`,
      {
        fix:
          `Re-encode, or replace the season with a smaller copy. Raise max_mbps in ` +
          `rules/shows.local.yaml if this is a bitrate you're happy to keep.`,
      }
    )
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

/**
 * Run the shows probe pass end-to-end: walk the library, probe each episode
 * (cache-aware), aggregate per show and season, and emit the per-season
 * quality_mismatch and large_file summaries. Cache writes are the caller's
 * responsibility.
 */
export async function probeShows(
  config: ShowsConfig,
  rules: ShowsRules,
  cache: ProbeCache,
  warnings: WarningCollector,
  dir: DirReader = new DirReader()
): Promise<ProbeResult<ShowProbeOutput[]>> {
  const collected = collectTasks(config, rules, dir)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  const identities = new Map<string, EpisodeIdentity>()
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

  if (rules.checks.warn_quality_mismatch) {
    reportQualityMismatches(probed, identities, rules, warnings)
  }
  if (rules.checks.warn_large_file) {
    reportLargeFiles(probed, identities, rules, warnings)
  }

  const categoryOrder = resolveCategories(rules.categories).map(c => c.name)
  const byPath = new Map<string, ProbeData>()
  for (const { task, data } of probed) byPath.set(task.relativePath, data)

  return { output: aggregate(probed, identities, categoryOrder), byPath }
}
