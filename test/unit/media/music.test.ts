import { describe, it, expect, vi } from 'vitest'

import { createMusicModule } from '../../../src/media/music'
import { defaultMusicRules, MusicRules } from '../../../src/core/rules/music'
import { scan } from '../../../src/core/scanner'
import { WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
import { buildLibrary, cleanupLibrary, probeMap, type DirSpec } from '../../fixtures/library'

function runMusicScan(opts: {
  spec: DirSpec
  rules?: Partial<MusicRules>
  /** Level-keyed ignore file contents, as `ignored/<drive>/music.yaml` parses. */
  ignored?: Record<string, string[]>
}) {
  const rules: MusicRules = {
    ...defaultMusicRules,
    categories: [{ name: 'Music' }, { name: 'Soundtracks' }],
    ...opts.rules,
  }
  const root = buildLibrary(opts.spec, 'moasys-music-')
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const module = createMusicModule(rules)
  const warnings = new WarningCollector(parseIgnoreList(opts.ignored ?? {}, 'music', 'test.yaml'))
  const probes = probeMap({})

  try {
    const records = scan({ root_path: root }, module, warnings, probes)
    const output = module.serialize(records)
    return { output, warnings: warnings.all() }
  } finally {
    logSpy.mockRestore()
    cleanupLibrary(root)
  }
}

describe('music module — happy paths', () => {
  it('catalogs an artist + album + track', () => {
    const result = runMusicScan({
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
    })
    expect(result.output).toEqual([
      {
        artist: 'Pink Floyd',
        albums: [
          {
            album: 'The Wall',
            track_count: 2,
            versions: [{ category: 'Music', quality: 'FLAC' }],
          },
        ],
      },
    ])
  })

  it('derives quality from file extension (uppercased)', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { '01 - Song.mp3': '' } },
        },
      },
    })
    expect(result.output[0]?.albums[0]?.versions[0]?.quality).toBe('MP3')
  })

  it('produces multiple versions for an album with mixed codecs in same category', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - Song A.flac': '',
              '02 - Song B.mp3': '',
            },
          },
        },
      },
    })
    const versions = result.output[0]?.albums[0]?.versions ?? []
    expect(versions).toContainEqual({ category: 'Music', quality: 'FLAC' })
    expect(versions).toContainEqual({ category: 'Music', quality: 'MP3' })
  })

  it('handles multi-disc albums via the disc-prefixed track convention', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          'Pink Floyd': {
            'The Wall': {
              '101 - In the Flesh.flac': '',
              '102 - The Thin Ice.flac': '',
              '201 - Hey You.flac': '',
            },
          },
        },
      },
    })
    expect(result.output[0]?.albums[0]?.track_count).toBe(3)
  })

  it('produces one version per category when album exists in multiple categories', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
        Soundtracks: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
      },
    })
    expect(result.output[0]?.albums[0]?.versions).toEqual([
      { category: 'Music', quality: 'FLAC' },
      { category: 'Soundtracks', quality: 'FLAC' },
    ])
  })

  it('sorts artists then albums alphabetically (case-insensitive)', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          'Beta Artist': { Album: { '01 - Song.flac': '' } },
          'alpha artist': { Album: { '01 - Song.flac': '' } },
        },
      },
    })
    expect(result.output.map(a => a.artist)).toEqual(['alpha artist', 'Beta Artist'])
  })
})

describe('music module — warnings', () => {
  it('warn_bad_track_name: track stem does not match either pattern', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { 'random.flac': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/File name is not '01 - Track Name'/))).toBe(
      true
    )
  })

  it('warn_no_audio: empty album folder', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { 'cover.jpg': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/folder has no audio files/))).toBe(true)
  })

  it('warn_track_gaps: missing track number in an album', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - One.flac': '',
              '03 - Three.flac': '', // track 02 missing
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Missing tracks in/))).toBe(true)
  })

  it('warn_duplicate_album: same album in multiple categories', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
        Soundtracks: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Also in \d+ other categories/))).toBe(true)
  })

  it('warn_duplicate_album: an `albums:` entry silences it', () => {
    // The check emits `Artist/Album` with no category, while the probe pass
    // emits `Category/Artist/Album` for the same album. A level-keyed entry
    // reaches both; a path prefix could only ever reach one.
    const result = runMusicScan({
      spec: {
        Music: { Artist: { Album: { '01 - Song.flac': '' } } },
        Soundtracks: { Artist: { Album: { '01 - Song.flac': '' } } },
      },
      ignored: { albums: ['Artist/Album'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_album')).toBe(false)
  })

  it('warn_duplicate_album: an `artists:` entry silences it too', () => {
    const result = runMusicScan({
      spec: {
        Music: { Artist: { Album: { '01 - Song.flac': '' } } },
        Soundtracks: { Artist: { Album: { '01 - Song.flac': '' } } },
      },
      ignored: { artists: ['Artist'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_album')).toBe(false)
  })

  it('warn_duplicate_album: silenced when category set is in acceptable_album_combos', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
        Soundtracks: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
      },
      rules: {
        acceptable_album_combos: [['Music', 'Soundtracks']],
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Also in \d+ other categories/))).toBe(false)
  })

  it('warn_duplicate_album: fires when category set does not match any acceptable combo', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
        Soundtracks: {
          Artist: { Album: { '01 - Song.flac': '' } },
        },
      },
      rules: {
        // Whitelists a different combo — the actual set {Music, Soundtracks}
        // still fires.
        acceptable_album_combos: [['Music', 'Other']],
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Also in \d+ other categories/))).toBe(true)
  })

  it('warn_loose_files: tracks directly in artist folder (no album wrapper)', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { '01 - Song.flac': '' },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/loose audio/i))).toBe(true)
  })

  it('warn_loose_files: tracks at category root', () => {
    const result = runMusicScan({
      spec: { Music: { '01 - Song.flac': '' } },
    })
    expect(result.warnings.some(w => w.issue.match(/loose audio/i))).toBe(true)
  })

  it('warn_extra_subfolders: nested folder inside album', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - Song.flac': '',
              Bonus: { '01 - Extra.flac': '' },
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected subfolder/))).toBe(true)
  })

  it('warn_unexpected_entries: stray file in album folder', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: {
            Album: {
              '01 - Song.flac': '',
              'notes.txt': '',
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected file/))).toBe(true)
  })

  it('warn_bad_artist_folder: fires when artist folder name does not match the configured pattern', () => {
    // Tighten the artist pattern to require leading capital so a lowercase
    // artist folder gets flagged. Pattern values are post-Zod {pattern,flags}
    // objects, not raw strings.
    const result = runMusicScan({
      spec: {
        Music: {
          'pink floyd': { 'The Wall': { '01 - Song.flac': '' } },
        },
      },
      rules: {
        patterns: {
          ...defaultMusicRules.patterns,
          artist_folder: { pattern: '^[A-Z].+$', flags: '' },
        },
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/Folder name does not match patterns.artist_folder/))
    ).toBe(true)
  })

  it('warn_bad_album_folder: fires when album folder name does not match the configured pattern', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          'Pink Floyd': { thewall: { '01 - Song.flac': '' } },
        },
      },
      rules: {
        patterns: {
          ...defaultMusicRules.patterns,
          album_folder: { pattern: '^[A-Z].+$', flags: '' },
        },
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/Folder name does not match patterns.album_folder/))
    ).toBe(true)
  })

  it('warn_suspicious_folder_chars: trailing whitespace on album folder', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          'Pink Floyd': {
            'The Wall ': { '01 - Song.flac': '' }, // trailing space
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Suspicious characters in album folder/))).toBe(
      true
    )
  })

  it('warn_suspicious_folder_chars: trailing whitespace on artist folder', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          'Artist ': { Album: { '01 - Song.flac': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Suspicious characters in artist folder/))).toBe(
      true
    )
  })

  it('warn_non_primary: a .wma file (non-primary)', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: { Album: { '01 - Song.wma': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Non-.FLAC/))).toBe(true)
  })

  it('warn_duplicate_track: two files with the same track number', () => {
    const result = runMusicScan({
      spec: {
        Soundtracks: {
          Soundtrack: {
            'Destiny 2': {
              '17 - The Wilds.flac': '',
              '18 - Holliday.flac': '',
              '18 - Holliday - Copy.flac': '',
            },
          },
        },
      },
    })
    const rows = result.warnings.filter(w => w.type === 'warn_duplicate_track')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.path).toBe('Soundtracks/Soundtrack/Destiny 2')
    expect(rows[0]?.issue).toBe(
      "Track 18 has 2 files: '18 - Holliday - Copy.flac', '18 - Holliday.flac'."
    )
  })

  it('warn_duplicate_track: names the disc on a multi-disc album', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          Artist: {
            Album: {
              '101 - One.flac': '',
              '201 - Two.flac': '',
              '202 - Four.flac': '',
              '203 - Three.flac': '',
              '203 - Three (alt).mp3': '',
            },
          },
        },
      },
    })
    const rows = result.warnings.filter(w => w.type === 'warn_duplicate_track')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.issue).toMatch(/^Disc 2 track 3 has 2 files:/)
  })

  it('warn_duplicate_track: the same track number on different discs is fine', () => {
    const result = runMusicScan({
      spec: {
        Music: { Artist: { Album: { '101 - One.flac': '', '201 - One.flac': '' } } },
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_track')).toBe(false)
  })

  it('warn_garbled_name: mis-encoded track names, summarized per album', () => {
    const result = runMusicScan({
      spec: {
        Soundtracks: {
          Soundtrack: {
            'The Witcher 3': {
              '25 - Welcome, Imlerith.flac': '',
              '26 - Drink Up, Thereâ€™s More!.flac': '',
              '27 - The Musty Scent of Fresh Pâté.flac': '',
            },
          },
        },
      },
    })
    const rows = result.warnings.filter(w => w.type === 'warn_garbled_name')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.path).toBe('Soundtracks/Soundtrack/The Witcher 3')
    expect(rows[0]?.issue).toBe(
      "1 file name(s): '26 - Drink Up, Thereâ€™s More!.flac' — 'â€™' → '’'."
    )
  })

  it('warn_garbled_name: mis-encoded artist and album folders', () => {
    const result = runMusicScan({
      spec: {
        Music: { 'BeyoncÃ©': { 'CafÃ© Tacvba': { '01 - Song.flac': '' } } },
      },
    })
    const rows = result.warnings
      .filter(w => w.type === 'warn_garbled_name')
      .map(w => [w.path, w.issue])
    expect(rows).toEqual([
      ['Music/BeyoncÃ©', "Artist folder should read 'Beyoncé'."],
      ['Music/BeyoncÃ©/CafÃ© Tacvba', "Album folder should read 'Café Tacvba'."],
    ])
  })

  it('the duplicate-track and garbled-name toggles silence them', () => {
    const result = runMusicScan({
      spec: {
        Music: {
          'BeyoncÃ©': { Album: { '01 - Thereâ€™s.flac': '', '01 - Copy.flac': '' } },
        },
      },
      rules: {
        checks: {
          ...defaultMusicRules.checks,
          warn_duplicate_track: false,
          warn_garbled_name: false,
        },
      },
    })
    expect(
      result.warnings.some(w => w.type === 'warn_duplicate_track' || w.type === 'warn_garbled_name')
    ).toBe(false)
  })

  it('toggles silence warnings when set to false', () => {
    const result = runMusicScan({
      spec: { Music: { '01 - Song.flac': '' } },
      rules: {
        checks: { ...defaultMusicRules.checks, warn_loose_files: false },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/loose audio/i))).toBe(false)
  })
})
