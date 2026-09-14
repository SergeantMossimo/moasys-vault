/**
 * probe/shows.ts
 * --------------
 * ffprobe pass for shows — walks the library, probes every primary episode
 * file (with cache), and writes the per-show/per-season aggregated result.
 *
 * Naming warnings are not re-emitted here — the scan pass handles those.
 * The probe pass only adds quality_mismatch warnings.
 */

import fs from 'fs'
import path from 'path'

import { ShowsConfig, WarningCollector } from '../core/types'
import { isPrimary } from '../core/files'
import { ShowsRules } from '../core/rules/shows'
import { compilePattern, resolveCategories } from '../core/rules/helpers'

import { ProbeCache } from './cache'
import { ProbeTask, ProbedFile, classifyQuality, probeBatch } from './helpers'
import { ShowProbeOutput, ShowSeasonProbe, EpisodeProbe, ProbeData, ProbeResult } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

interface ShowIdentity {
  title: string
  year: number
}

interface EpisodeIdentity {
  show: ShowIdentity
  seasonLabel: string // "1", "Specials", etc.
  episodeId: string // "S01E01" or "S01E01-E02"
}

function parseShowFolder(name: string, regex: RegExp): ShowIdentity | null {
  const m = regex.exec(name)
  if (!m?.groups) return null
  const { title, year } = m.groups
  if (title === undefined || year === undefined) return null
  return { title: title.trim(), year: parseInt(year, 10) }
}

function parseSeasonFolder(name: string, regex: RegExp): number | null {
  const m = regex.exec(name)
  if (!m?.groups) return null
  const season = m.groups.season
  if (season === undefined) return null
  return parseInt(season, 10)
}

interface FileParse {
  season: number
  firstEpisode: number
  lastEpisode: number
}

function parseFileStem(stem: string, regex: RegExp): FileParse | null {
  const m = regex.exec(stem)
  if (!m?.groups) return null
  const { season, episode, episode_end } = m.groups
  if (season === undefined || episode === undefined) return null
  const first = parseInt(episode, 10)
  const last = episode_end !== undefined ? parseInt(episode_end, 10) : first
  return { season: parseInt(season, 10), firstEpisode: first, lastEpisode: last }
}

function formatEpisodeId(season: number, first: number, last: number): string {
  const s = String(season).padStart(2, '0')
  const e1 = String(first).padStart(2, '0')
  if (last === first) return `S${s}E${e1}`
  const e2 = String(last).padStart(2, '0')
  return `S${s}E${e1}-E${e2}`
}

function showKey(t: string, y: number): string {
  return `${t.toLowerCase()}|${y}`
}

function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Sort key for season labels — numeric first (in numeric order), then named
 * (alphabetical). Matches the scan-side ordering.
 */
function seasonSortKey(label: string): [number, number, string] {
  const n = parseInt(label, 10)
  if (!isNaN(n)) return [0, n, '']
  return [1, 0, label.toLowerCase()]
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

function collectTasks(
  config: ShowsConfig,
  rules: ShowsRules
): Array<{ task: ProbeTask; identity: EpisodeIdentity }> {
  const showFolderRegex = compilePattern(rules.patterns.show_folder)
  const seasonFolderRegex = compilePattern(rules.patterns.season_folder)
  const fileRegex = compilePattern(rules.patterns.file)
  const ignoredLower = rules.ignored_season_names.map(n => n.toLowerCase())

  const out: Array<{ task: ProbeTask; identity: EpisodeIdentity }> = []

  for (const cat of resolveCategories(rules.categories)) {
    const folderPath = path.join(config.root_path, cat.folderName)
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      console.log(`    [SKIP] Category folder not found: ${folderPath}`)
      continue
    }

    for (const showEntry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!showEntry.isDirectory()) continue
      const show = parseShowFolder(showEntry.name, showFolderRegex)
      if (!show) continue // Scan pass already warned

      const showPath = path.join(folderPath, showEntry.name)
      let seasonEntries: fs.Dirent[]
      try {
        seasonEntries = fs.readdirSync(showPath, { withFileTypes: true })
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
          files = fs.readdirSync(seasonPath, { withFileTypes: true })
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
  qualityOrder: string[]
): ShowProbeOutput[] {
  const shows = new Map<
    string,
    { title: string; year: number; seasons: Map<string, EpisodeProbe[]> }
  >()

  for (const { task, data } of probed) {
    const id = identities.get(task.relativePath)
    if (!id) continue

    const key = showKey(id.show.title, id.show.year)
    let show = shows.get(key)
    if (!show) {
      show = { title: id.show.title, year: id.show.year, seasons: new Map() }
      shows.set(key, show)
    }
    let seasonEps = show.seasons.get(id.seasonLabel)
    if (!seasonEps) {
      seasonEps = []
      show.seasons.set(id.seasonLabel, seasonEps)
    }
    seasonEps.push({
      quality: task.category,
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

  const qIndex = (q: string) => {
    const i = qualityOrder.indexOf(q)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }

  return [...shows.values()]
    .sort((a, b) => {
      const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
      return t !== 0 ? t : a.year - b.year
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
            // Sort by episode id, then quality
            if (a.episode !== b.episode) return a.episode.localeCompare(b.episode)
            return qIndex(a.quality) - qIndex(b.quality)
          }),
        }))
      return { title: show.title, year: show.year, seasons }
    })
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

export async function probeShows(
  config: ShowsConfig,
  rules: ShowsRules,
  cache: ProbeCache,
  warnings: WarningCollector
): Promise<ProbeResult<ShowProbeOutput[]>> {
  const collected = collectTasks(config, rules)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  const identities = new Map<string, EpisodeIdentity>()
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

  if (rules.checks.warn_quality_mismatch) {
    for (const { task, data } of probed) {
      if (!data.video) continue
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

  const qualityOrder = resolveCategories(rules.categories).map(c => c.name)
  const byPath = new Map<string, ProbeData>()
  for (const { task, data } of probed) byPath.set(task.relativePath, data)

  return { output: aggregate(probed, identities, qualityOrder), byPath }
}
