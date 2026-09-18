import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { probeMusic } from '../../../src/probe/music'
import { defaultMusicRules, type MusicRules } from '../../../src/core/rules/music'
import { ProbeCache } from '../../../src/probe/cache'
import { WarningCollector } from '../../../src/core/types'
import type { AudioProbe, ProbeData, TagData } from '../../../src/probe/types'
import { buildLibrary, fakeProbe, type DirSpec } from '../../fixtures/library'

function primeCache(cachePath: string, root: string, data: Record<string, ProbeData>): ProbeCache {
  const cache = new ProbeCache(cachePath)
  for (const [relPath, probeData] of Object.entries(data)) {
    const stat = fs.statSync(path.join(root, relPath))
    // Primed entries count as tag-read, so `tags: null` means "no tags" rather
    // than triggering a backfill read of the empty fixture file.
    cache.set(relPath, stat.mtimeMs, stat.size, { tags_read: true, ...probeData })
  }
  return cache
}

const flacAudio = (overrides: Partial<AudioProbe> = {}): AudioProbe => ({
  codec: 'flac',
  bitrate: null,
  sample_rate: 44100,
  bit_depth: 16,
  channels: 2,
  ...overrides,
})

const mp3Audio = (overrides: Partial<AudioProbe> = {}): AudioProbe => ({
  codec: 'mp3',
  bitrate: 320_000,
  sample_rate: 44100,
  bit_depth: null,
  channels: 2,
  ...overrides,
})

const tags = (overrides: Partial<TagData> = {}): TagData => ({
  title: 'Track Title',
  artist: 'Pink Floyd',
  album_artist: 'Pink Floyd',
  album: 'The Wall',
  year: 1979,
  track: 1,
  total_tracks: null,
  disc: 1,
  total_discs: null,
  genre: null,
  ...overrides,
})

describe('probeMusic', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-music-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function setup(opts: {
    spec: DirSpec
    rules?: Partial<MusicRules>
    probes: Record<string, ProbeData>
  }) {
    const rules: MusicRules = {
      ...defaultMusicRules,
      categories: [{ name: 'Music' }],
      ...opts.rules,
    }
    const root = buildLibrary(opts.spec, 'moasys-probemusic-')
    const cache = primeCache(path.join(tmpDir, 'probe.json'), root, opts.probes)
    const warnings = new WarningCollector()
    return { rules, root, cache, warnings }
  }

  it('aggregates tracks by artist and album, derives audio_quality_summary', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Pink Floyd': {
            'The Wall': {
              '01 - In the Flesh.flac': '',
              '02 - The Thin Ice.flac': '',
            },
          },
        },
      },
      probes: {
        'Music/Pink Floyd/The Wall/01 - In the Flesh.flac': fakeProbe({
          audio: flacAudio(),
        }),
        'Music/Pink Floyd/The Wall/02 - The Thin Ice.flac': fakeProbe({
          audio: flacAudio(),
        }),
      },
    })

    const result = await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(result.output[0]?.albums[0]?.audio_quality_summary).toEqual(['FLAC 16/44.1'])
  })

  it('emits warn_quality_inconsistent when an album mixes codecs', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - One.flac': '',
              '02 - Two.mp3': '',
            },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - One.flac': fakeProbe({ audio: flacAudio() }),
        'Music/Artist/Album/02 - Two.mp3': fakeProbe({ audio: mp3Audio() }),
      },
    })
    // Music rules default audio_extensions don't include .mp3 in primary, but
    // the rules accept both. Force primary to include both so both are probed.
    const fullRules: MusicRules = {
      ...rules,
      primary_extension: ['.flac', '.mp3'],
    }

    await probeMusic({ root_path: root }, fullRules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Mixed track quality/i))).toBe(true)
  })

  it('suppresses codec-mix warning when the combo is in acceptable_codec_combos', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - One.flac': '',
              '02 - Two.mp3': '',
            },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - One.flac': fakeProbe({ audio: flacAudio() }),
        'Music/Artist/Album/02 - Two.mp3': fakeProbe({ audio: mp3Audio() }),
      },
    })
    const fullRules: MusicRules = {
      ...rules,
      primary_extension: ['.flac', '.mp3'],
      acceptable_codec_combos: [['FLAC', 'MP3']],
    }

    await probeMusic({ root_path: root }, fullRules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Mixed track quality/i))).toBe(false)
  })

  it('still fires for codec mixes NOT in acceptable_codec_combos', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - One.flac': '',
              '02 - Two.mp3': '',
            },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - One.flac': fakeProbe({ audio: flacAudio() }),
        'Music/Artist/Album/02 - Two.mp3': fakeProbe({ audio: mp3Audio() }),
      },
    })
    const fullRules: MusicRules = {
      ...rules,
      primary_extension: ['.flac', '.mp3'],
      // Whitelists a different combo, so [FLAC, MP3] still warns.
      acceptable_codec_combos: [['FLAC', 'WAV']],
    }

    await probeMusic({ root_path: root }, fullRules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Mixed track quality/i))).toBe(true)
  })

  it('does not silence bitrate-spread cases even when the codec is whitelisted alone', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - One.mp3': '',
              '02 - Two.mp3': '',
            },
          },
        },
      },
      probes: {
        // Same codec, very different bitrates → bitrate spread, single codec
        'Music/Artist/Album/01 - One.mp3': fakeProbe({
          audio: mp3Audio({ bitrate: 128_000 }),
          bitrate: 128_000,
        }),
        'Music/Artist/Album/02 - Two.mp3': fakeProbe({
          audio: mp3Audio({ bitrate: 320_000 }),
          bitrate: 320_000,
        }),
      },
    })
    const fullRules: MusicRules = {
      ...rules,
      primary_extension: ['.mp3'],
      // Single-codec entry — bitrate-spread cases must still fire.
      acceptable_codec_combos: [['MP3']],
    }

    await probeMusic({ root_path: root }, fullRules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Mixed track quality/i))).toBe(true)
  })

  it('emits warn_mono_audio summarising mono tracks in an album', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - Mono.flac': '',
              '02 - Stereo.flac': '',
            },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - Mono.flac': fakeProbe({
          audio: flacAudio({ channels: 1 }),
        }),
        'Music/Artist/Album/02 - Stereo.flac': fakeProbe({
          audio: flacAudio({ channels: 2 }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)

    const monoWarnings = warnings.all().filter(w => w.type === 'warn_mono_audio')
    expect(monoWarnings).toHaveLength(1)
    expect(monoWarnings[0]?.issue).toMatch(/1\/2 tracks are mono/i)
    expect(monoWarnings[0]?.path).toMatch(/Music\/Artist\/Album/)
  })

  it('does not emit warn_mono_audio when every track is stereo', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: { '01 - Stereo.flac': '' },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - Stereo.flac': fakeProbe({
          audio: flacAudio({ channels: 2 }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_mono_audio')).toBe(false)
  })

  it('respects the warn_mono_audio toggle', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: { '01 - Mono.flac': '' },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - Mono.flac': fakeProbe({
          audio: flacAudio({ channels: 1 }),
        }),
      },
    })
    const offRules: MusicRules = {
      ...rules,
      checks: { ...rules.checks, warn_mono_audio: false },
    }

    await probeMusic({ root_path: root }, offRules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_mono_audio')).toBe(false)
  })

  it('emits warn_compilation_detected when AlbumArtist values differ', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Some Artist': {
            'Compilation Album': {
              '01 - One.flac': '',
              '02 - Two.flac': '',
            },
          },
        },
      },
      probes: {
        'Music/Some Artist/Compilation Album/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'Artist A' }),
        }),
        'Music/Some Artist/Compilation Album/02 - Two.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'Artist B' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/distinct AlbumArtist tags/i))).toBe(true)
  })

  it('skips warn_compilation_detected when folder is "Various Artists"', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Various Artists': {
            'Comp Album': {
              '01 - One.flac': '',
              '02 - Two.flac': '',
            },
          },
        },
      },
      probes: {
        'Music/Various Artists/Comp Album/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'Artist A' }),
        }),
        'Music/Various Artists/Comp Album/02 - Two.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'Artist B' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/distinct AlbumArtist tags/i))).toBe(false)
  })

  it('emits warn_folder_tag_mismatch when AlbumArtist tag differs from folder name', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Pink Floid': {
            // misspelled folder
            'The Wall': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/Pink Floid/The Wall/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'Pink Floyd' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Artist folder is .*AlbumArtist tag is/i))).toBe(
      true
    )
  })

  it('emits warn_folder_tag_mismatch when Album tag differs from folder name', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Pink Floyd': {
            'The Wal': { '01 - One.flac': '' }, // misspelled folder
          },
        },
      },
      probes: {
        'Music/Pink Floyd/The Wal/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album: 'The Wall' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Album folder is .*Album tag is/i))).toBe(true)
  })

  it('emits warn_folder_tag_case, not mismatch, when only capitalization differs', async () => {
    // compareTagToFolder used to lowercase both sides, so this drift was
    // completely invisible — it fragments a Plex library the same way a real
    // mismatch does, but deserves its own lower-severity bucket.
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          // Album folder matches its tag exactly; only the artist drifts, so
          // the assertion below isolates the artist comparison.
          'Talespin Soundtrack': { 'The Wall': { '01 - One.flac': '' } },
        },
      },
      probes: {
        'Music/Talespin Soundtrack/The Wall/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'TaleSpin Soundtrack' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    const types = warnings.all().map(w => w.type)
    expect(types).toContain('warn_folder_tag_case')
    expect(types).not.toContain('warn_folder_tag_mismatch')
  })

  it('does NOT fire folder/tag mismatch when tag has illegal chars matching folder', async () => {
    // ID3 tag "AC/DC" must be folder "ACDC" (slash is filename-illegal).
    // After stripping illegal chars, both match — no warning should fire.
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          ACDC: {
            'Back in Black': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/ACDC/Back in Black/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'AC/DC', album: 'Back in Black' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Folder\/tag mismatch/i))).toBe(false)
  })

  it('does NOT fire folder/tag mismatch when tag has a trailing period (Windows strips it)', async () => {
    // ID3 tag "P.O.D." cannot exist as a folder on Windows — the OS silently
    // drops the trailing period, so the folder is "P.O.D". Both forms should
    // compare equal so we don't false-fire on every album by this artist.
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'P.O.D': {
            'The Fundamental Elements of Southtown': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/P.O.D/The Fundamental Elements of Southtown/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({
            album_artist: 'P.O.D.',
            album: 'The Fundamental Elements of Southtown',
          }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Folder\/tag mismatch/i))).toBe(false)
  })

  it('does NOT fire folder/tag mismatch when album tag has a trailing period', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'The Monkees': {
            'Billboard Hits U.S.A': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/The Monkees/Billboard Hits U.S.A/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({
            album_artist: 'The Monkees',
            album: 'Billboard Hits U.S.A.',
          }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Folder\/tag mismatch/i))).toBe(false)
  })

  it('suggests the filename-safe form in the recommended fix when tag has illegal chars', async () => {
    // Tag "Friends:" (colon is illegal) → suggested folder is "Friends" not "Friends:".
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Bad Folder': {
            'Some Album': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/Bad Folder/Some Album/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ album_artist: 'Friends:', album: 'Some Album' }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    const mismatch = warnings
      .all()
      .find(w => w.issue.match(/Artist folder is .*AlbumArtist tag is/i))
    expect(mismatch?.issue).toContain("Suggested folder: 'Friends'") // no colon
    expect(mismatch?.issue).not.toContain("Suggested folder: 'Friends:'")
  })

  it('emits warn_missing_tags when required tag fields are blank', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Pink Floyd': {
            'The Wall': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/Pink Floyd/The Wall/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ title: null, album: null, artist: null, album_artist: null }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/missing title, album or artist tags/i))).toBe(
      true
    )
  })

  it('emits warn_track_number_mismatch when filename track number differs from tag', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          'Pink Floyd': {
            'The Wall': { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/Pink Floyd/The Wall/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({ track: 5 }), // tag says 5, filename says 01
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(
      warnings.all().some(w => w.issue.match(/number differs between filename and tag/i))
    ).toBe(true)
  })

  it('skips tag-driven checks when no tracks have tags', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: { '01 - One.flac': '' },
          },
        },
      },
      probes: {
        'Music/Artist/Album/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: null, // no tags at all
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all()).toEqual([])
  })

  it('silences warnings when their toggles are false', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Music: {
          Artist: {
            Album: { '01 - One.flac': '' },
          },
        },
      },
      rules: {
        checks: {
          ...defaultMusicRules.checks,
          warn_compilation_detected: false,
          warn_folder_tag_mismatch: false,
          warn_missing_tags: false,
          warn_track_number_mismatch: false,
        },
      },
      probes: {
        'Music/Artist/Album/01 - One.flac': fakeProbe({
          audio: flacAudio(),
          tags: tags({
            title: null,
            album: 'wrong-album',
            album_artist: 'wrong-artist',
            track: 99,
          }),
        }),
      },
    })

    await probeMusic({ root_path: root }, rules, cache, warnings)
    expect(warnings.all()).toEqual([])
  })
})
