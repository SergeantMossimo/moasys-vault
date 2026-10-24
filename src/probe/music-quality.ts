/**
 * probe/music-quality.ts
 * ----------------------
 * Audio-quality derivation for the music probe pass. Two layers:
 *
 *   1. Per-track: `deriveAudioQuality(audio, containerBitrate)` turns an
 *      ffprobe audio stream into a human-readable string like
 *      "FLAC 16/44.1" (lossless) or "MP3 320" (lossy).
 *
 *   2. Per-album: `summarizeAlbumQuality(tracks)` deduplicates the per-track
 *      strings into a short summary that accounts for VBR encoding variance
 *      (e.g. a V0-encoded album's tracks span ~220–260 kbps but should
 *      collapse into a single "MP3 ~240" entry, not 40 separate ones).
 *
 * Kept in its own file because it's pure, easy to test in isolation, and the
 * thresholds (VBR_TOLERANCE_KBPS, lossless codec list) benefit from being
 * findable when someone needs to tune them.
 */

import { AudioProbe, TrackProbe } from './types'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Codecs that store audio without lossy compression. For these, quality is
 * defined by bit depth + sample rate rather than bitrate (the bitrate of a
 * FLAC file is highly variable and doesn't reflect "quality" the way it does
 * for MP3/AAC).
 */
const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wavpack', 'ape', 'tak'])

/**
 * Whether ffprobe's codec name is lossless. Uncompressed audio (WAV, AIFF)
 * reports as `pcm_s16le`, `pcm_s24be` and friends rather than a container
 * name, so the whole `pcm_` family counts.
 */
function isLosslessCodec(codec: string): boolean {
  const c = codec.toLowerCase()
  return LOSSLESS_CODECS.has(c) || c.startsWith('pcm_')
}

/** The label a codec gets in a quality string — every PCM variant reads as `PCM`. */
function codecLabel(codec: string): string {
  return codec.toLowerCase().startsWith('pcm_') ? 'PCM' : codec.toUpperCase()
}

/**
 * VBR (variable bitrate) tolerance for the album quality summary. Tracks
 * of the same codec whose actual bitrates span ≤ this many kbps are
 * collapsed into a single averaged entry (e.g. "MP3 ~288"). Beyond this
 * the spread indicates real inconsistency and warrants separate entries
 * plus a warning.
 *
 * 64 kbps is wide enough to cover LAME V0 (~220-260) and similar VBR
 * presets, narrow enough that 128 vs 256 in the same album still splits.
 */
const VBR_TOLERANCE_KBPS = 64

// ─────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────

/**
 * Format sample rate (Hz) as a clean kHz string: 44100 → "44.1", 48000 → "48",
 * 96000 → "96". No trailing ".0" on round values.
 */
function formatKhz(hz: number): string {
  const khz = hz / 1000
  return khz % 1 === 0 ? String(khz) : khz.toFixed(1)
}

// ─────────────────────────────────────────────
// Per-track derivation
// ─────────────────────────────────────────────

/**
 * Derive a human-readable quality string from an audio stream.
 *
 *   Lossless: `"FLAC 16/44.1"`, `"FLAC 24/96"`, `"ALAC 16/44.1"`
 *   Lossy:    `"MP3 320"`, `"AAC 256"`, `"OGG 192"`
 *
 * Returns null when there's no audio stream or we can't derive anything
 * meaningful (rare — ffprobe usually gives us at least codec + something).
 *
 * `containerBitrate` is the format-level bitrate from ffprobe, used as a
 * fallback when the audio stream doesn't report its own bitrate (common
 * for AAC inside MP4 containers).
 */
export function deriveAudioQuality(
  audio: AudioProbe | null,
  containerBitrate: number | null
): string | null {
  if (!audio) return null
  const codecUpper = codecLabel(audio.codec)

  if (isLosslessCodec(audio.codec)) {
    // Lossless: codec + bit_depth/sample_rate
    if (audio.bit_depth && audio.sample_rate) {
      return `${codecUpper} ${audio.bit_depth}/${formatKhz(audio.sample_rate)}`
    }
    if (audio.sample_rate) return `${codecUpper} ${formatKhz(audio.sample_rate)}`
    return codecUpper
  }

  // Lossy: codec + kbps. Prefer the audio stream's own bitrate, fall back
  // to the container bitrate for codecs that don't report it directly.
  const bps = audio.bitrate ?? containerBitrate
  if (bps) return `${codecUpper} ${Math.round(bps / 1000)}`
  return codecUpper
}

// ─────────────────────────────────────────────
// Per-album summary
// ─────────────────────────────────────────────

/**
 * Aggregate per-track quality strings into a deduplicated per-album summary
 * that accounts for VBR variance. Tracks with the same codec whose actual
 * bitrates differ by less than VBR_TOLERANCE_KBPS collapse into a single
 * `"CODEC ~avg"` entry; tracks with a wider spread or mixed codecs stay
 * separate (which triggers the `warn_quality_inconsistent` warning).
 *
 * Lossless tracks within an album always report identical bit_depth/sample
 * rate, so their per-track strings deduplicate trivially.
 */
export function summarizeAlbumQuality(tracks: TrackProbe[]): string[] {
  const losslessSet = new Set<string>()
  const lossyByCodec = new Map<string, number[]>() // codec → kbps values

  for (const t of tracks) {
    if (!t.audio || !t.audio_quality) continue
    if (isLosslessCodec(t.audio.codec)) {
      losslessSet.add(t.audio_quality)
      continue
    }
    const bps = t.audio.bitrate ?? t.bitrate
    if (!bps) continue
    const codec = t.audio.codec.toLowerCase()
    const arr = lossyByCodec.get(codec) ?? []
    arr.push(Math.round(bps / 1000))
    lossyByCodec.set(codec, arr)
  }

  const out: string[] = [...losslessSet]

  for (const [codec, bitrates] of lossyByCodec) {
    if (bitrates.length === 0) continue
    const min = Math.min(...bitrates)
    const max = Math.max(...bitrates)
    const codecUpper = codec.toUpperCase()
    if (max - min <= VBR_TOLERANCE_KBPS) {
      // Within VBR tolerance — collapse to a single averaged entry rounded
      // to the nearest 16 kbps. Tilde signals "approximate average".
      const avg = bitrates.reduce((s, b) => s + b, 0) / bitrates.length
      out.push(`${codecUpper} ~${Math.round(avg / 16) * 16}`)
    } else {
      // Spread exceeds VBR tolerance — list distinct exact values so the
      // user can see exactly what they're dealing with.
      for (const b of [...new Set(bitrates)].sort((a, b) => a - b)) {
        out.push(`${codecUpper} ${b}`)
      }
    }
  }

  return out.sort()
}
