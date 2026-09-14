/**
 * plex/log-parser.ts
 * ------------------
 * Turn the zip Plex serves at `/diagnostics/logs` into problem events: the
 * ERROR and WARN lines of the server and scanner logs, each tagged with the
 * item or file it concerns when that can be told reliably.
 *
 * Plex rarely names a file on the line that reports a problem. It names the
 * item by its metadata id — the same `rating_key` the catalog pull records —
 * or it announces the item on an earlier line of the same thread:
 *
 *   [CreditsDetectionManager] Running credits detection for item 77957
 *   [CreditsDetectionManager] BufferingLineReader: failed to read line (error: -1)
 *
 * So an event gets its item from, in order:
 *   1. an item id or library path on the line itself;
 *   2. the most recent ANNOUNCING line on the same thread (see ANNOUNCERS),
 *      within CONTEXT_WINDOW_MS.
 *
 * Only announcing lines set context — never an arbitrary line that happens
 * to mention a path, because Plex reuses threads for unrelated work and that
 * pins router errors on episodes. Request-handler errors (`[Req#…]`) never
 * take context either: they're about an HTTP request, not the item a
 * background job was last busy with.
 *
 * Pure: no filesystem or network access.
 */

import { unzipSync } from 'fflate'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type LogLevel = 'ERROR' | 'WARN'

/** One log file from the archive. */
export interface LogFile {
  /** File name inside the zip, e.g. `Plex Media Server.1.log`. */
  name: string
  /** The log without its rotation number, e.g. `Plex Media Scanner Analysis`. */
  family: string
  text: string
}

/** One logical log line — continuation lines are folded into `message`. */
export interface LogLine {
  /** Server-local time, sortable: `2026-09-13 20:03:08.777`. */
  timestamp: string
  thread: string
  level: string
  message: string
}

/** An ERROR or WARN line, with the item or file it concerns when known. */
export interface LogEvent {
  family: string
  timestamp: string
  level: LogLevel
  /** The leading `[Component]` tag without request ids, e.g. `CreditsDetectionManager`. */
  component: string | null
  message: string
  /** `message` with ids, numbers, and paths generalized — groups repeats of one problem. */
  signature: string
  /** Plex metadata id (catalog `rating_key`) the event concerns. */
  ratingKey: string | null
  /** Server-side path the event concerns. */
  plexPath: string | null
  /** How the item was found: on the line itself, or from the thread's announcing line. */
  via: 'line' | 'context' | null
}

// ─────────────────────────────────────────────
// Archive
// ─────────────────────────────────────────────

/**
 * The logs worth reading: the server log and every scanner log (Analysis,
 * Matcher, Credits, …). Crash-uploader, tuner, and transcoder-statistics
 * logs say nothing about library files.
 */
const LOG_NAME = /^(Plex Media (?:Server|Scanner[^/.]*))(?:\.\d+)?\.log$/

/** Extract the server and scanner logs from the `/diagnostics/logs` zip. */
export function readLogArchive(zip: Uint8Array): LogFile[] {
  const entries = unzipSync(zip, {
    filter: file => LOG_NAME.test(baseName(file.name)),
  })
  const decoder = new TextDecoder('utf-8')
  return Object.entries(entries)
    .map(([name, bytes]) => ({
      name: baseName(name),
      family: LOG_NAME.exec(baseName(name))![1]!,
      text: decoder.decode(bytes),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

// ─────────────────────────────────────────────
// Lines
// ─────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
}

/** `Sep 13, 2026 20:03:08.777 [139873737083704] INFO - message` */
const LINE =
  /^([A-Z][a-z]{2}) (\d{2}), (\d{4}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) \[([^\]]*)\] (\w+) - (.*)$/

/** Split a log into lines, folding lines that don't start with a timestamp into the one before. */
export function parseLogLines(text: string): LogLine[] {
  const lines: LogLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (m) {
      const [, mon, day, year, time, thread, level, message] = m
      const month = MONTHS[mon!]
      if (month) {
        lines.push({
          timestamp: `${year}-${month}-${day} ${time}`,
          thread: thread!,
          level: level!,
          message: message!,
        })
        continue
      }
    }
    const last = lines.at(-1)
    if (last && raw.trim().length > 0) last.message += `\n${raw}`
  }
  return lines
}

/** Milliseconds for comparing two timestamps from the same log. */
function timeValue(timestamp: string): number {
  return Date.parse(timestamp.replace(' ', 'T') + 'Z')
}

// ─────────────────────────────────────────────
// Signatures
// ─────────────────────────────────────────────

/** Request ids: `[Req#1f0a2]`, `[Req#effb/PhotoTranscoder/Req#f3]`. */
const REQUEST_ID = /Req#[0-9a-f]+\/?/g

/** The leading `[Component]` tag, request ids removed; null when the line has none. */
export function componentOf(message: string): string | null {
  const m = /^\[([^\]]+)\]/.exec(message)
  if (!m) return null
  const component = m[1]!.replace(REQUEST_ID, '').replace(/\/+$/, '')
  return component.length > 0 ? component : null
}

/**
 * Generalize a message so repeats of one problem share a signature: request
 * ids dropped; quoted strings that look like paths, absolute paths, Plex
 * guids, long hex runs, and numbers replaced with placeholders.
 */
export function normalizeSignature(message: string): string {
  return message
    .split('\n')[0]!
    .replace(/\[Req#[0-9a-f]+\]\s*/g, '')
    .replace(REQUEST_ID, '')
    .replace(/\b[a-z]+:\/\/[a-z]+\/[0-9a-f]+(?:,[a-z]+:\/\/[a-z]+\/[0-9a-f]+)*/g, '<guids>')
    .replace(/(["'])\/[^"']*\1/g, '<path>')
    .replace(/(?<![\w:/])\/(?:[^\s"',\]]+\/)+[^\s"',\]]*/g, '<path>')
    .replace(/\b[0-9a-f]{8,}(?:-[0-9a-f]{4,})*\b/gi, '<hex>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

// ─────────────────────────────────────────────
// Items on a line
// ─────────────────────────────────────────────

/** Ways a line names a Plex metadata id directly. */
const ITEM_ID_PATTERNS = [
  /\bitem (\d+)\b/,
  /\bmetadata_item_id=(\d+)\b/,
  /\/library\/metadata\/(\d+)\b/,
]

/**
 * Lines that announce which item or file a thread is about to work on. Only
 * these set a thread's context. `key` lines start a new item; `path` lines
 * add the file being opened for the current one.
 */
const ANNOUNCERS: Array<{ pattern: RegExp; kind: 'key' | 'path' }> = [
  { pattern: /^\[CreditsDetectionManager\] Running credits detection for item (\d+)/, kind: 'key' },
  { pattern: /^Butler: Scheduling credits marker creation for: (\d+)/, kind: 'key' },
  { pattern: /^Analyzing media parts for item (\d+)/, kind: 'key' },
  { pattern: /^\[ID -?\d+\] Media part analysis: (\/.+)$/, kind: 'path' },
  { pattern: /^\[MI\] Opening input file: "(\/.+)"$/, kind: 'path' },
]

/**
 * How long an announcement stays the thread's context. Credits detection
 * runs FFmpeg over the whole file before reporting, which takes seconds to
 * a minute or two on a NAS.
 */
export const CONTEXT_WINDOW_MS = 5 * 60_000

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a finder for library paths inside a message. A path starts at one of
 * the libraries' folder prefixes and runs to a quote, bracket, or the end of
 * the line — paths contain spaces, so whitespace can't end one.
 */
export function libraryPathFinder(prefixes: string[]): (message: string) => string | null {
  const usable = [...new Set(prefixes.map(p => p.replace(/\/+$/, '')).filter(p => p.length > 1))]
  if (usable.length === 0) return () => null
  usable.sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(?:${usable.map(escapeRegExp).join('|')})/[^"'\\]\\n]+`)
  return message => {
    const m = pattern.exec(message)
    return m ? m[0].replace(/[\s,;:]+$/, '') : null
  }
}

// ─────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────

interface ThreadContext {
  ratingKey: string | null
  plexPath: string | null
  at: number
}

/**
 * The ERROR and WARN events in one log file.
 * @param findPath  from `libraryPathFinder(every library folder)`
 */
export function extractEvents(
  file: LogFile,
  findPath: (message: string) => string | null
): LogEvent[] {
  const events: LogEvent[] = []
  const contexts = new Map<string, ThreadContext>()

  for (const line of parseLogLines(file.text)) {
    const firstLine = line.message.split('\n')[0]!

    for (const { pattern, kind } of ANNOUNCERS) {
      const m = pattern.exec(firstLine)
      if (!m) continue
      const at = timeValue(line.timestamp)
      const current = contexts.get(line.thread)
      if (kind === 'key') {
        contexts.set(line.thread, { ratingKey: m[1]!, plexPath: null, at })
      } else {
        const fresh = current && at - current.at <= CONTEXT_WINDOW_MS
        contexts.set(line.thread, {
          ratingKey: fresh ? current.ratingKey : null,
          plexPath: m[1]!,
          at,
        })
      }
      break
    }

    if (line.level !== 'ERROR' && line.level !== 'WARN') continue

    let ratingKey: string | null = null
    for (const pattern of ITEM_ID_PATTERNS) {
      const m = pattern.exec(firstLine)
      if (m) {
        ratingKey = m[1]!
        break
      }
    }
    let plexPath = findPath(line.message)
    let via: LogEvent['via'] = ratingKey !== null || plexPath !== null ? 'line' : null

    if (via === null && !firstLine.includes('Req#')) {
      const context = contexts.get(line.thread)
      if (context && timeValue(line.timestamp) - context.at <= CONTEXT_WINDOW_MS) {
        ratingKey = context.ratingKey
        plexPath = context.plexPath
        via = 'context'
      }
    }

    events.push({
      family: file.family,
      timestamp: line.timestamp,
      level: line.level as LogLevel,
      component: componentOf(firstLine),
      message: line.message,
      signature: normalizeSignature(line.message),
      ratingKey,
      plexPath,
      via,
    })
  }
  return events
}
