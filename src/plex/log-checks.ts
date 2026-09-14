/**
 * plex/log-checks.ts
 * ------------------
 * Tie log events (plex/log-parser.ts) to files in the library, turn the ones
 * that land on a drive into warnings, and summarize everything else.
 *
 * An event names an item by its metadata id or by a server path. Ids are
 * looked up in the catalogs from `plex:pull` — the same `rating_key` — and
 * paths by the files those catalogs list, falling back to the libraries'
 * mapped folders. Both end up as a drive plus library-relative path, so
 * warnings sit alongside the scan's and the ignore lists apply.
 *
 * Pure: no filesystem or network access.
 */

import { WarningCollector } from '../core/types'
import { PlexRules } from '../core/rules/plex'

import { normalizePath, stripPrefix } from './paths'
import { LogEvent, LogLevel } from './log-parser'
import { MediaType, PlexCatalogItem, PlexCatalogOutput } from './types'

// ─────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────

/** A place in a library an event concerns. */
export interface LogTarget {
  mediaType: MediaType
  /** Root name from config.json. */
  drive: string
  /** Library-relative path, forward slashes. */
  libraryPath: string
  /** True for a file, false for a folder (a show, season, or album with no file of its own). */
  isFile: boolean
}

export interface ResolvedLogEvent extends LogEvent {
  targets: LogTarget[]
  /** The event names an item id the last pull doesn't have — the pull is older than the log. */
  unknownItem: boolean
}

/**
 * Media and subtitle extensions. A path the catalog doesn't list is only
 * treated as a file when it ends in one — folder names like `11.22.63` end in
 * something extension-shaped too.
 */
const FILE_EXTENSION =
  /\.(?:mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|mpe?g|webm|flac|mp3|m4a|m4b|aac|ogg|opus|wav|wma|aiff?|srt|ass|ssa|sub|idx|vtt)$/i

const looksLikeFile = (p: string) => FILE_EXTENSION.test(p)

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Looks up the items and files that log events name, across every pulled library. */
export class LogItemIndex {
  private readonly byKey = new Map<string, { item: PlexCatalogItem; mediaType: MediaType }>()
  /** Files of the episodes/tracks under a show, season, artist, or album. */
  private readonly childFiles = new Map<string, LogTarget[]>()
  private readonly byPath = new Map<string, LogTarget>()
  private readonly locations: Array<{
    plexPath: string
    mediaType: MediaType
    drive: string
    libraryPath: string
  }> = []

  constructor(catalogs: PlexCatalogOutput[]) {
    for (const catalog of catalogs) {
      const mediaType = catalog.library.media_type
      if (mediaType === null) continue

      for (const l of catalog.library.mapped_locations ?? []) {
        this.locations.push({
          plexPath: normalizePath(l.plex_path),
          mediaType,
          drive: l.drive,
          libraryPath: l.library_path,
        })
      }

      for (const item of catalog.items) {
        this.byKey.set(item.rating_key, { item, mediaType })
        for (const file of item.files) {
          if (file.drive === null || file.library_path === null) continue
          const target: LogTarget = {
            mediaType,
            drive: file.drive,
            libraryPath: file.library_path,
            isFile: true,
          }
          this.byPath.set(normalizePath(file.plex_path).toLowerCase(), target)
          for (const parent of [item.parent_rating_key, item.grandparent_rating_key]) {
            if (parent === null) continue
            this.childFiles.set(parent, [...(this.childFiles.get(parent) ?? []), target])
          }
        }
      }
    }
    this.locations.sort((a, b) => b.plexPath.length - a.plexPath.length)
  }

  /** Every server path the libraries cover — what to look for in log lines. */
  get locationPrefixes(): string[] {
    return this.locations.map(l => l.plexPath)
  }

  resolve(event: LogEvent): ResolvedLogEvent {
    // A path is the more precise of the two: it names one part of a multi-file item.
    if (event.plexPath !== null) {
      const target = this.resolvePath(event.plexPath)
      if (target) return { ...event, targets: [target], unknownItem: false }
    }
    if (event.ratingKey !== null) {
      const entry = this.byKey.get(event.ratingKey)
      if (!entry) return { ...event, targets: [], unknownItem: true }
      return {
        ...event,
        targets: this.itemTargets(entry.item, entry.mediaType),
        unknownItem: false,
      }
    }
    return { ...event, targets: [], unknownItem: false }
  }

  private resolvePath(plexPath: string): LogTarget | null {
    const known = this.byPath.get(normalizePath(plexPath).toLowerCase())
    if (known) return known
    for (const l of this.locations) {
      const rest = stripPrefix(plexPath, l.plexPath)
      if (rest === null) continue
      const libraryPath = [l.libraryPath, rest].filter(s => s.length > 0).join('/')
      if (libraryPath.length === 0) return null
      return { mediaType: l.mediaType, drive: l.drive, libraryPath, isFile: looksLikeFile(rest) }
    }
    return null
  }

  private itemTargets(item: PlexCatalogItem, mediaType: MediaType): LogTarget[] {
    const own = item.files.flatMap<LogTarget>(f =>
      f.drive !== null && f.library_path !== null
        ? [{ mediaType, drive: f.drive, libraryPath: f.library_path, isFile: true }]
        : []
    )
    if (own.length > 0) return own

    // A show, season, artist, or album: point at the folders its files sit in.
    const folders = new Map<string, LogTarget>()
    for (const child of this.childFiles.get(item.rating_key) ?? []) {
      const folder = dirname(child.libraryPath)
      folders.set(`${child.drive}|${folder}`, { ...child, libraryPath: folder, isFile: false })
    }
    return [...folders.values()]
  }
}

// ─────────────────────────────────────────────
// Known problems
// ─────────────────────────────────────────────

interface KnownProblem {
  matches: (event: LogEvent) => boolean
  label: string
  advice: string
}

/**
 * Plain-language explanations for the problems Plex logs about files most
 * often. First match wins; anything unlisted gets the generic entry.
 */
const KNOWN_PROBLEMS: KnownProblem[] = [
  {
    matches: e => e.component === 'CreditsDetectionManager' && /multi-part/i.test(e.message),
    label: "Credits detection doesn't support items split across several files",
    advice:
      'Plex can only add Skip Credits to single-file items. Combine the parts into one file if you want it; otherwise this is harmless.',
  },
  {
    matches: e => e.component?.startsWith('CreditsDetectionManager') ?? false,
    label: 'Credits detection failed',
    advice:
      "Plex's credits detection gave up on these files and won't retry, so they get no Skip Credits button; Plex doesn't log why. " +
      'When whole seasons fail together the cause is usually the encoding, not damage, and nothing needs fixing. ' +
      "When only a file or two fail, play their last few minutes — a file that's truncated near the end is worth replacing.",
  },
  {
    matches: e => e.component === 'Time' && /date looks invalid/i.test(e.message),
    label: 'An embedded date tag is invalid',
    advice:
      "Plex couldn't parse a date in the file's metadata. Fix the tag with a tag editor (MKVToolNix, Mp3tag), or ignore this if Plex shows the right date.",
  },
  {
    matches: e => e.component === 'FFMPEG',
    label: "Plex's media analysis (FFmpeg) reported a problem reading the file",
    advice:
      'Often a harmless muxing quirk. If the file plays badly in Plex, remux it (MKVToolNix, or ffmpeg with -c copy) or replace it.',
  },
]

const GENERIC_PROBLEM: KnownProblem = {
  matches: () => true,
  label: 'Plex logged a problem while working on this item',
  advice:
    'Search for the sample line in the Plex forums. If it keeps recurring, try "Analyze" or "Refresh Metadata" on the item in Plex.',
}

export function explainProblem(event: LogEvent): KnownProblem {
  return KNOWN_PROBLEMS.find(p => p.matches(event)) ?? GENERIC_PROBLEM
}

// ─────────────────────────────────────────────
// Warnings
// ─────────────────────────────────────────────

export interface PlexLogCheckInput {
  mediaType: MediaType
  /** Root name from config.json. */
  drive: string
  events: ResolvedLogEvent[]
  rules: PlexRules
  warnings: WarningCollector
}

const WARNING_TYPE: Record<LogLevel, 'warn_plex_log_error' | 'warn_plex_log_warning'> = {
  ERROR: 'warn_plex_log_error',
  WARN: 'warn_plex_log_warning',
}

interface ProblemGroup {
  problem: KnownProblem
  lines: number
  files: Set<string>
  first: string
  last: string
  sample: string
}

/** Up to `max` quoted file names, then a count of the rest. */
function listNames(paths: string[], max = 5): string {
  const names = paths.slice(0, max).map(p => `'${basename(p)}'`)
  return names.join(', ') + (paths.length > max ? `, +${paths.length - max} more` : '')
}

/** Trim a sample line to something readable inside a warning. */
function sampleLine(message: string): string {
  const first = message.split('\n')[0]!
  return first.length > 240 ? `${first.slice(0, 237)}…` : first
}

/**
 * Emit one warning per folder and level for the events that land on this
 * drive and media type, listing each distinct problem with its files, line
 * count, time span, and a sample line.
 * @returns how many events landed here
 */
export function checkPlexLogs(input: PlexLogCheckInput): number {
  const { mediaType, drive, rules, warnings } = input
  const byFolder = new Map<
    string,
    { folder: string; level: LogLevel; problems: Map<string, ProblemGroup> }
  >()
  let landed = 0

  for (const event of input.events) {
    const targets = event.targets.filter(
      t => t.mediaType === mediaType && t.drive.toLowerCase() === drive.toLowerCase()
    )
    if (targets.length === 0) continue
    landed++

    const problem = explainProblem(event)
    for (const target of targets) {
      const folder = target.isFile ? dirname(target.libraryPath) : target.libraryPath
      const groupKey = `${event.level}|${folder.toLowerCase()}`
      const group = byFolder.get(groupKey) ?? { folder, level: event.level, problems: new Map() }
      byFolder.set(groupKey, group)

      const entry = group.problems.get(problem.label) ?? {
        problem,
        lines: 0,
        files: new Set<string>(),
        first: event.timestamp,
        last: event.timestamp,
        sample: sampleLine(event.message),
      }
      entry.lines++
      if (target.isFile) entry.files.add(target.libraryPath)
      if (event.timestamp < entry.first) entry.first = event.timestamp
      if (event.timestamp > entry.last) entry.last = event.timestamp
      group.problems.set(problem.label, entry)
    }
  }

  for (const { folder, level, problems } of byFolder.values()) {
    const type = WARNING_TYPE[level]
    if (!rules.checks[type]) continue
    const levelWord = level === 'ERROR' ? 'errors' : 'warnings'
    const parts = [...problems.values()].map(p => {
      const files = p.files.size > 0 ? ` for ${listNames([...p.files])}` : ''
      const when = p.first === p.last ? `at ${p.first}` : `from ${p.first} to ${p.last}`
      return (
        `${p.problem.label}${files} — ${p.lines} log line(s) ${when}. ${p.problem.advice} ` +
        `Sample: "${p.sample}"`
      )
    })
    warnings.add(
      type,
      folder,
      `Plex's logs have ${levelWord} about this folder. ${parts.join(' | ')}`
    )
  }
  return landed
}

// ─────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────

export interface PlexLogProblemSummary {
  level: LogLevel
  /** Log the lines came from, e.g. `Plex Media Server`. */
  log: string
  component: string | null
  signature: string
  count: number
  /** Lines of this signature tied to a file or folder in a configured library. */
  tied_to_library: number
  first_seen: string
  last_seen: string
  sample: string
}

/** output/plex/logs-summary.json */
export interface PlexLogSummaryOutput {
  generated: string
  log_files: string[]
  /** Server-local time of the first and last problem line in the archive. */
  covers: { from: string | null; to: string | null }
  totals: {
    errors: number
    warnings: number
    tied_to_library: number
    /** Lines naming an item id the last `plex:pull` doesn't have. */
    unknown_items: number
  }
  /** Every distinct problem, most frequent first. */
  problems: PlexLogProblemSummary[]
}

export function summarizeLogs(
  events: ResolvedLogEvent[],
  logFiles: string[]
): Omit<PlexLogSummaryOutput, 'generated'> {
  const groups = new Map<string, PlexLogProblemSummary>()
  let from: string | null = null
  let to: string | null = null

  for (const e of events) {
    if (from === null || e.timestamp < from) from = e.timestamp
    if (to === null || e.timestamp > to) to = e.timestamp

    const key = `${e.level}|${e.family}|${e.signature}`
    const group = groups.get(key) ?? {
      level: e.level,
      log: e.family,
      component: e.component,
      signature: e.signature,
      count: 0,
      tied_to_library: 0,
      first_seen: e.timestamp,
      last_seen: e.timestamp,
      sample: sampleLine(e.message),
    }
    group.count++
    if (e.targets.length > 0) group.tied_to_library++
    if (e.timestamp < group.first_seen) group.first_seen = e.timestamp
    if (e.timestamp > group.last_seen) group.last_seen = e.timestamp
    groups.set(key, group)
  }

  return {
    log_files: logFiles,
    covers: { from, to },
    totals: {
      errors: events.filter(e => e.level === 'ERROR').length,
      warnings: events.filter(e => e.level === 'WARN').length,
      tied_to_library: events.filter(e => e.targets.length > 0).length,
      unknown_items: events.filter(e => e.unknownItem).length,
    },
    problems: [...groups.values()].sort(
      (a, b) => b.count - a.count || a.signature.localeCompare(b.signature)
    ),
  }
}
