/**
 * probe/ffprobe.ts
 * ----------------
 * Thin wrapper around the bundled ffprobe binary.
 *
 * Invokes ffprobe with -print_format json and parses the result into our
 * trimmed ProbeData shape (see ./types.ts). Only the fields we actually use
 * downstream are kept — raw ffprobe JSON has dozens of fields per stream
 * and caching all of them would bloat the cache file for no benefit.
 *
 * No types shipped with ffprobe-static, so a small ambient declaration
 * lives here. The runtime shape is `{ path: string, version: string }`.
 */

import { spawn } from 'child_process'

import ffprobeStatic from 'ffprobe-static'

import { ProbeData, VideoProbe, AudioProbe } from './types'

// Ambient declaration for ffprobe-static lives in ./ffprobe-static.d.ts
// since TS doesn't allow inline augmentation of untyped JS modules.

// ─────────────────────────────────────────────
// Raw ffprobe JSON shape (only the fields we read)
// ─────────────────────────────────────────────

interface RawStream {
  codec_type: 'video' | 'audio' | 'subtitle' | 'data'
  codec_name?: string
  width?: number
  height?: number
  bit_rate?: string // ffprobe returns numbers as strings in JSON output
  sample_rate?: string
  channels?: number
  bits_per_raw_sample?: string
  bits_per_sample?: number
  /** Average frame rate as "num/den" e.g. "24000/1001". */
  avg_frame_rate?: string
  /**
   * Per-stream disposition flags. `attached_pic: 1` means the stream is
   * embedded artwork (e.g. an MP3 cover image) rather than playable video.
   * Detection via this flag is more reliable than codec sniffing.
   */
  disposition?: Record<string, number>
}

interface RawFormat {
  size?: string
  duration?: string
  bit_rate?: string
}

interface RawProbe {
  streams?: RawStream[]
  format?: RawFormat
}

// ─────────────────────────────────────────────
// Spawning ffprobe
// ─────────────────────────────────────────────

/**
 * How long one ffprobe may run. It reads only headers, so even a large remux
 * on a network share answers in seconds; anything this slow is a stalled
 * share or a pathological file, and waiting on it would hang the whole run.
 */
const FFPROBE_TIMEOUT_MS = 120_000

/**
 * Run a command and collect its stdout, rejecting on a non-zero exit, a spawn
 * failure, or when it outlives `timeoutMs` (it's killed). Output is decoded
 * as UTF-8 across chunk boundaries, so a multi-byte character in a tag or
 * file name split between two reads arrives intact.
 */
export function runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // FFREPORT would make ffprobe write a log file; the app writes nothing it
    // doesn't own, so it's cleared from the child's environment.
    const env = { ...process.env }
    delete env.FFREPORT
    const child = spawn(command, args, { windowsHide: true, env })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`))
      else if (code !== 0) reject(new Error(`exited ${code}: ${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}

/**
 * Run ffprobe against a single file and return the parsed JSON.
 * Rejects if ffprobe exits non-zero, can't be found, times out, or emits
 * malformed JSON.
 *
 * `-v quiet` silences the human-readable log lines so stdout is pure JSON.
 * `-show_streams -show_format` requests both the per-stream and format-level
 * info we care about. We deliberately avoid -show_chapters / -show_packets —
 * those balloon output and we don't use them.
 */
async function runFFprobe(filePath: string): Promise<RawProbe> {
  let stdout: string
  try {
    stdout = await runProcess(
      ffprobeStatic.path,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      FFPROBE_TIMEOUT_MS
    )
  } catch (err) {
    throw new Error(`ffprobe ${(err as Error).message} for ${filePath}`, { cause: err })
  }
  try {
    return JSON.parse(stdout) as RawProbe
  } catch (err) {
    throw new Error(`ffprobe returned non-JSON for ${filePath}: ${(err as Error).message}`, {
      cause: err,
    })
  }
}

// ─────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────

/** Parse a string-or-undefined integer field, returning null when missing or NaN. */
function intOrNull(s: string | undefined): number | null {
  if (s === undefined) return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

/** Same as intOrNull but for floats. */
function floatOrNull(s: string | undefined): number | null {
  if (s === undefined) return null
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse ffprobe's "num/den" fractional frame rate notation into a decimal.
 * Returns null for "0/0" (which means "unknown" in ffprobe's vocabulary) or
 * any malformed input.
 */
function parseFrameRate(s: string | undefined): number | null {
  if (!s) return null
  const [numStr, denStr] = s.split('/')
  if (numStr === undefined || denStr === undefined) return null
  const num = parseFloat(numStr)
  const den = parseFloat(denStr)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return num / den
}

/**
 * Extract the first PLAYABLE video stream summary, or null if there are none.
 * Embedded artwork streams (MP3 cover images, etc.) are skipped via the
 * disposition.attached_pic flag — they'd otherwise pollute audio-file output
 * with bogus 2400x2400 "video" entries.
 */
function summarizeVideo(streams: RawStream[]): VideoProbe | null {
  const v = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  if (!v || !v.codec_name || v.width === undefined || v.height === undefined) return null
  return {
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    frame_rate: parseFrameRate(v.avg_frame_rate),
  }
}

/**
 * Extract the first audio stream summary, or null if there are none.
 *
 * For lossless formats ffprobe sometimes reports bit depth via
 * `bits_per_raw_sample` and sometimes `bits_per_sample` — try both.
 */
function summarizeAudio(streams: RawStream[]): AudioProbe | null {
  const a = streams.find(s => s.codec_type === 'audio')
  if (!a || !a.codec_name) return null
  const bitDepth =
    intOrNull(a.bits_per_raw_sample) ??
    (typeof a.bits_per_sample === 'number' && a.bits_per_sample > 0 ? a.bits_per_sample : null)
  return {
    codec: a.codec_name,
    bitrate: intOrNull(a.bit_rate),
    sample_rate: intOrNull(a.sample_rate),
    bit_depth: bitDepth,
    channels: a.channels ?? null,
  }
}

/**
 * Probe a file and return the normalized ProbeData.
 * Surface-level errors (file unreadable, codec we don't recognize) reject.
 */
export async function probeFile(filePath: string): Promise<ProbeData> {
  const raw = await runFFprobe(filePath)
  const streams = raw.streams ?? []
  const fmt = raw.format ?? {}

  return {
    size_bytes: intOrNull(fmt.size) ?? 0,
    duration_seconds: floatOrNull(fmt.duration),
    bitrate: intOrNull(fmt.bit_rate),
    video: summarizeVideo(streams),
    audio: summarizeAudio(streams),
    // Tags are read separately by the music and audiobook probes (see
    // src/probe/id3.ts). For movies and shows they stay null.
    tags: null,
  }
}
