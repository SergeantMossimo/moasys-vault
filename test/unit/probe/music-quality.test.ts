import { describe, it, expect } from 'vitest'

import { deriveAudioQuality, summarizeAlbumQuality } from '../../../src/probe/music-quality'
import type { AudioProbe, TrackProbe } from '../../../src/probe/types'

const lossless = (overrides: Partial<AudioProbe> = {}): AudioProbe => ({
  codec: 'flac',
  bitrate: null,
  sample_rate: 44100,
  bit_depth: 16,
  channels: 2,
  ...overrides,
})

const lossy = (overrides: Partial<AudioProbe> = {}): AudioProbe => ({
  codec: 'mp3',
  bitrate: 320_000,
  sample_rate: 44100,
  bit_depth: null,
  channels: 2,
  ...overrides,
})

const track = (overrides: Partial<TrackProbe> = {}): TrackProbe => ({
  category: 'Music',
  path: 'Music/Artist/Album/01 - Track.flac',
  disc: 1,
  track: 1,
  size_bytes: 0,
  duration_seconds: null,
  bitrate: null,
  video: null,
  audio: lossless(),
  tags: null,
  audio_quality: 'FLAC 16/44.1',
  ...overrides,
})

describe('deriveAudioQuality', () => {
  it('returns null for null audio', () => {
    expect(deriveAudioQuality(null, null)).toBeNull()
  })

  it('treats uncompressed PCM (WAV/AIFF) as lossless', () => {
    expect(deriveAudioQuality(lossless({ codec: 'pcm_s16le' }), 1_411_000)).toBe('PCM 16/44.1')
    expect(
      deriveAudioQuality(lossless({ codec: 'pcm_s24be', bit_depth: 24, sample_rate: 96000 }), null)
    ).toBe('PCM 24/96')
  })

  describe('lossless codecs', () => {
    it('formats FLAC with 16-bit / 44.1kHz', () => {
      expect(deriveAudioQuality(lossless({ codec: 'flac' }), null)).toBe('FLAC 16/44.1')
    })

    it('formats FLAC with 24-bit / 96kHz hi-res', () => {
      expect(
        deriveAudioQuality(lossless({ codec: 'flac', bit_depth: 24, sample_rate: 96000 }), null)
      ).toBe('FLAC 24/96')
    })

    it('formats ALAC the same way as FLAC', () => {
      expect(deriveAudioQuality(lossless({ codec: 'alac' }), null)).toBe('ALAC 16/44.1')
    })

    it('strips trailing .0 on round-number sample rates', () => {
      expect(deriveAudioQuality(lossless({ bit_depth: 16, sample_rate: 48000 }), null)).toBe(
        'FLAC 16/48'
      )
    })

    it('keeps decimal precision for fractional kHz', () => {
      expect(deriveAudioQuality(lossless({ bit_depth: 16, sample_rate: 22050 }), null)).toBe(
        'FLAC 16/22.1'
      )
    })

    it('falls back to codec + sample rate when bit_depth is missing', () => {
      expect(deriveAudioQuality(lossless({ bit_depth: null, sample_rate: 44100 }), null)).toBe(
        'FLAC 44.1'
      )
    })

    it('falls back to bare codec when both bit_depth and sample rate are missing', () => {
      expect(deriveAudioQuality(lossless({ bit_depth: null, sample_rate: null }), null)).toBe(
        'FLAC'
      )
    })

    it('uppercases the codec name', () => {
      expect(deriveAudioQuality(lossless({ codec: 'WAVPack' }), null)).toMatch(/^WAVPACK/)
    })
  })

  describe('lossy codecs', () => {
    it('formats MP3 320', () => {
      expect(deriveAudioQuality(lossy({ codec: 'mp3', bitrate: 320_000 }), null)).toBe('MP3 320')
    })

    it('rounds bitrate to the nearest kbps', () => {
      // 287_500 bps rounds to 288 kbps.
      expect(deriveAudioQuality(lossy({ bitrate: 287_500 }), null)).toBe('MP3 288')
    })

    it('formats AAC with the audio stream bitrate', () => {
      expect(deriveAudioQuality(lossy({ codec: 'aac', bitrate: 256_000 }), null)).toBe('AAC 256')
    })

    it('falls back to container bitrate when audio stream has none', () => {
      // AAC in MP4 often doesn't report a stream bitrate.
      expect(deriveAudioQuality(lossy({ codec: 'aac', bitrate: null }), 256_000)).toBe('AAC 256')
    })

    it('returns bare codec when no bitrate is available anywhere', () => {
      expect(deriveAudioQuality(lossy({ codec: 'mp3', bitrate: null }), null)).toBe('MP3')
    })

    it('prefers stream bitrate over container bitrate when both are present', () => {
      expect(deriveAudioQuality(lossy({ codec: 'mp3', bitrate: 320_000 }), 128_000)).toBe('MP3 320')
    })
  })
})

describe('summarizeAlbumQuality', () => {
  it('returns an empty array for an empty track list', () => {
    expect(summarizeAlbumQuality([])).toEqual([])
  })

  it('returns one entry for a uniformly-lossless album', () => {
    const tracks = Array.from({ length: 12 }, (_, i) =>
      track({ track: i + 1, audio_quality: 'FLAC 16/44.1' })
    )
    expect(summarizeAlbumQuality(tracks)).toEqual(['FLAC 16/44.1'])
  })

  it('deduplicates lossless tracks with identical bit_depth/sample_rate', () => {
    const tracks = [
      track({ audio_quality: 'FLAC 16/44.1' }),
      track({ audio_quality: 'FLAC 16/44.1' }),
      track({ audio_quality: 'FLAC 16/44.1' }),
    ]
    expect(summarizeAlbumQuality(tracks)).toEqual(['FLAC 16/44.1'])
  })

  it('lists distinct lossless variants when they differ', () => {
    const tracks = [
      track({
        audio: lossless({ bit_depth: 16, sample_rate: 44100 }),
        audio_quality: 'FLAC 16/44.1',
      }),
      track({
        audio: lossless({ bit_depth: 24, sample_rate: 96000 }),
        audio_quality: 'FLAC 24/96',
      }),
    ]
    expect(summarizeAlbumQuality(tracks).sort()).toEqual(['FLAC 16/44.1', 'FLAC 24/96'])
  })

  it('collapses VBR lossy tracks within tolerance into one averaged entry', () => {
    // V0 LAME typically ranges 220-260 kbps; should collapse into one ~240 entry.
    const bitrates = [222, 245, 258, 230, 240, 250]
    const tracks = bitrates.map(kbps =>
      track({
        audio: lossy({ codec: 'mp3', bitrate: kbps * 1000 }),
        audio_quality: `MP3 ${kbps}`,
      })
    )
    const summary = summarizeAlbumQuality(tracks)
    expect(summary.length).toBe(1)
    expect(summary[0]).toMatch(/^MP3 ~/) // tilde signals averaged value
  })

  it('keeps lossy tracks as separate entries when spread exceeds 64 kbps', () => {
    const tracks = [
      track({
        audio: lossy({ codec: 'mp3', bitrate: 128_000 }),
        audio_quality: 'MP3 128',
      }),
      track({
        audio: lossy({ codec: 'mp3', bitrate: 256_000 }),
        audio_quality: 'MP3 256',
      }),
    ]
    const summary = summarizeAlbumQuality(tracks)
    expect(summary.length).toBe(2)
    expect(summary).toContain('MP3 128')
    expect(summary).toContain('MP3 256')
  })

  it('handles mixed-codec albums (lossless + lossy in same album)', () => {
    const tracks = [
      track({
        audio: lossless({ codec: 'flac' }),
        audio_quality: 'FLAC 16/44.1',
      }),
      track({
        audio: lossy({ codec: 'mp3', bitrate: 320_000 }),
        audio_quality: 'MP3 320',
      }),
    ]
    const summary = summarizeAlbumQuality(tracks)
    expect(summary.length).toBe(2)
    expect(summary).toContain('FLAC 16/44.1')
    // Lossy entries always go through the averaging path, so even a single
    // track produces "~320" not "320". The tilde is the consistent marker.
    expect(summary).toContain('MP3 ~320')
  })

  it('skips tracks with no audio data', () => {
    const tracks = [track({ audio: null, audio_quality: null })]
    expect(summarizeAlbumQuality(tracks)).toEqual([])
  })

  it('rounds VBR averages to nearest 16 kbps', () => {
    // Average should round; e.g. 244 average becomes 240 (nearest 16).
    const tracks = [
      track({ audio: lossy({ bitrate: 240_000 }), audio_quality: 'MP3 240' }),
      track({ audio: lossy({ bitrate: 248_000 }), audio_quality: 'MP3 248' }),
    ]
    const summary = summarizeAlbumQuality(tracks)
    // Average is 244, nearest 16 is 240.
    expect(summary).toEqual(['MP3 ~240'])
  })

  it('returns sorted output for stable diffs', () => {
    const tracks = [
      track({ audio: lossy({ codec: 'mp3', bitrate: 320_000 }), audio_quality: 'MP3 320' }),
      track({ audio: lossless({ codec: 'flac' }), audio_quality: 'FLAC 16/44.1' }),
    ]
    const summary = summarizeAlbumQuality(tracks)
    expect(summary).toEqual([...summary].sort())
  })
})
