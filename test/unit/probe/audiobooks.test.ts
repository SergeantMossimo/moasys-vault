import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { probeAudiobooks } from '../../../src/probe/audiobooks'
import { defaultAudiobooksRules, type AudiobooksRules } from '../../../src/core/rules/audiobooks'
import { ProbeCache } from '../../../src/probe/cache'
import { WarningCollector } from '../../../src/core/types'
import type { ProbeData } from '../../../src/probe/types'
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

describe('probeAudiobooks', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-audiobooks-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function setup(opts: {
    spec: DirSpec
    rules?: Partial<AudiobooksRules>
    probes: Record<string, ProbeData>
  }) {
    const rules: AudiobooksRules = {
      ...defaultAudiobooksRules,
      categories: [{ name: 'Audible' }],
      ...opts.rules,
    }
    const root = buildLibrary(opts.spec, 'moasys-probeaudiobooks-')
    const cache = primeCache(path.join(tmpDir, 'probe.json'), root, opts.probes)
    const warnings = new WarningCollector()
    return { rules, root, cache, warnings }
  }

  it('aggregates chapters by book and parses authors', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Audible: {
          'J.R.R. Tolkien': {
            'The Hobbit': {
              '01 - One.mp3': '',
              '02 - Two.mp3': '',
            },
          },
        },
      },
      probes: {
        'Audible/J.R.R. Tolkien/The Hobbit/01 - One.mp3': fakeProbe(),
        'Audible/J.R.R. Tolkien/The Hobbit/02 - Two.mp3': fakeProbe(),
      },
    })

    const result = await probeAudiobooks({ root_path: root }, rules, cache, warnings)
    expect(result.output).toHaveLength(1)
    expect(result.output[0]?.title).toBe('The Hobbit')
    expect(result.output[0]?.authors).toEqual(['J.R.R. Tolkien'])
    expect(result.output[0]?.chapters).toHaveLength(2)
  })

  it('parses comma-and-joined multi-author folders', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Audible: {
          'Author 1, Author 2, and Author 3': {
            Book: { '01 - Chapter.mp3': '' },
          },
        },
      },
      probes: {
        'Audible/Author 1, Author 2, and Author 3/Book/01 - Chapter.mp3': fakeProbe(),
      },
    })

    const result = await probeAudiobooks({ root_path: root }, rules, cache, warnings)
    expect(result.output[0]?.authors).toEqual(['Author 1', 'Author 2', 'Author 3'])
  })

  it('orders chapters by disc then chapter number', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Audible: {
          Author: {
            Book: {
              '201 - Disc 2 Chapter 1.mp3': '',
              '101 - Disc 1 Chapter 1.mp3': '',
              '102 - Disc 1 Chapter 2.mp3': '',
            },
          },
        },
      },
      probes: {
        'Audible/Author/Book/101 - Disc 1 Chapter 1.mp3': fakeProbe(),
        'Audible/Author/Book/102 - Disc 1 Chapter 2.mp3': fakeProbe(),
        'Audible/Author/Book/201 - Disc 2 Chapter 1.mp3': fakeProbe(),
      },
    })

    const result = await probeAudiobooks({ root_path: root }, rules, cache, warnings)
    const chapters = result.output[0]?.chapters ?? []
    expect(chapters.map(c => `${c.disc}.${c.chapter}`)).toEqual(['1.1', '1.2', '2.1'])
  })

  const tags = (album: string, artist: string) => ({
    title: null,
    artist,
    album_artist: null,
    album,
    year: null,
    track: null,
    total_tracks: null,
    disc: null,
    total_discs: null,
    genre: null,
  })

  it('emits no warnings when tags agree with the folders', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Audible: {
          'Andy Weir': { 'The Martian': { '01 - Chapter.mp3': '' } },
        },
      },
      probes: {
        'Audible/Andy Weir/The Martian/01 - Chapter.mp3': fakeProbe({
          tags: tags('The Martian (Unabridged)', 'Andy Weir'),
        }),
      },
    })

    await probeAudiobooks({ root_path: root }, rules, cache, warnings)
    expect(warnings.all()).toEqual([])
  })

  it('emits tag warnings at Category/Author/Book', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Audible: {
          'Cassandra Rose Clarke': { 'Halo - Battle Born': { '01 - Chapter.mp3': '' } },
        },
      },
      probes: {
        'Audible/Cassandra Rose Clarke/Halo - Battle Born/01 - Chapter.mp3': fakeProbe({
          tags: tags('Halo: Battle Born (Unabridged)', 'Cassandra Rose Clark'),
        }),
      },
    })

    await probeAudiobooks({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().map(w => [w.type, w.path])).toEqual([
      ['warn_author_tag_mismatch', 'Audible/Cassandra Rose Clarke/Halo - Battle Born'],
    ])
  })

  it('emits warn_missing_book_tags when no chapter has tags', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        Audible: {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
      },
      probes: { 'Audible/Author/Book/01 - Chapter.mp3': fakeProbe() },
    })

    await probeAudiobooks({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().map(w => w.type)).toEqual(['warn_missing_book_tags'])
  })
})
