import { describe, it, expect, vi } from 'vitest'

import { createAudiobooksModule } from '../../../src/media/audiobooks'
import { defaultAudiobooksRules, AudiobooksRules } from '../../../src/core/rules/audiobooks'
import { scan } from '../../../src/core/scanner'
import { WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
import { buildLibrary, cleanupLibrary, probeMap, type DirSpec } from '../../fixtures/library'

function runAudiobooksScan(opts: {
  spec: DirSpec
  rules?: Partial<AudiobooksRules>
  /** Level-keyed ignore file contents, as `ignored/<drive>/audiobooks.yaml` parses. */
  ignored?: Record<string, string[]>
}) {
  const rules: AudiobooksRules = {
    ...defaultAudiobooksRules,
    categories: [{ name: 'Audible' }, { name: 'Book On CD' }],
    ...opts.rules,
  }
  const root = buildLibrary(opts.spec, 'moasys-audiobooks-')
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const module = createAudiobooksModule(rules)
  const warnings = new WarningCollector(
    parseIgnoreList(opts.ignored ?? {}, 'audiobooks', 'test.yaml')
  )
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

describe('audiobooks module — happy paths', () => {
  it('catalogs a single-author book', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          'J.R.R. Tolkien': {
            'The Hobbit': {
              '01 - Unexpected Party.mp3': '',
              '02 - Roast Mutton.mp3': '',
            },
          },
        },
      },
    })
    expect(result.output).toEqual([
      {
        title: 'The Hobbit',
        authors: ['J.R.R. Tolkien'],
        chapter_count: 2,
        versions: [{ category: 'Audible', quality: 'MP3' }],
      },
    ])
  })

  it('parses comma-separated multi-author folders', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          'Terry Pratchett, Neil Gaiman': {
            'Good Omens': { '01 - Chapter.mp3': '' },
          },
        },
      },
    })
    expect(result.output[0]?.authors).toEqual(['Terry Pratchett', 'Neil Gaiman'])
  })

  it('parses Author1, Author2, and Author3 format', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          'Author 1, Author 2, and Author 3': {
            Book: { '01 - Chapter.mp3': '' },
          },
        },
      },
    })
    expect(result.output[0]?.authors).toEqual(['Author 1', 'Author 2', 'Author 3'])
  })

  it('handles multi-disc books with disc-prefixed chapter numbers', () => {
    const result = runAudiobooksScan({
      spec: {
        'Book On CD': {
          Author: {
            Book: {
              '101 - Chapter 1.mp3': '',
              '102 - Chapter 2.mp3': '',
              '201 - Chapter 1.mp3': '',
            },
          },
        },
      },
    })
    expect(result.output[0]?.chapter_count).toBe(3)
  })

  it('produces one version per category when book is in multiple categories', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
        'Book On CD': {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
      },
    })
    expect(result.output[0]?.versions).toEqual([
      { category: 'Audible', quality: 'MP3' },
      { category: 'Book On CD', quality: 'MP3' },
    ])
  })

  it('sorts books by title alphabetically', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: {
            Beta: { '01 - Chapter.mp3': '' },
            Alpha: { '01 - Chapter.mp3': '' },
          },
        },
      },
    })
    expect(result.output.map(b => b.title)).toEqual(['Alpha', 'Beta'])
  })
})

describe('audiobooks module — warnings', () => {
  it('warn_bad_chapter_name: chapter file does not match the pattern', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { Book: { 'chapter.mp3': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Chapter file name does not match/))).toBe(true)
  })

  it('warn_no_audio: empty book folder', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { Book: { 'cover.jpg': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/No recognized audio files/))).toBe(true)
  })

  it('warn_chapter_gaps: missing chapter number in a book', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: {
            Book: {
              '01 - One.mp3': '',
              '03 - Three.mp3': '', // 02 missing
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Potential missing chapters/))).toBe(true)
  })

  it('warn_duplicate_book: a `books:` entry silences it despite the path having no category', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: { Author: { Book: { '01 - Chapter.mp3': '' } } },
        'Book On CD': { Author: { Book: { '01 - Chapter.mp3': '' } } },
      },
      ignored: { books: ['Author/Book'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_book')).toBe(false)
  })

  it('warn_duplicate_book: a `folders:` entry reaches it as well', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: { Author: { Book: { '01 - Chapter.mp3': '' } } },
        'Book On CD': { Author: { Book: { '01 - Chapter.mp3': '' } } },
      },
      ignored: { folders: ['Book On CD'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_book')).toBe(false)
  })

  it('warn_duplicate_book: same title in multiple categories', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
        'Book On CD': {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/Duplicate book found in multiple categories/))
    ).toBe(true)
  })

  it('warn_duplicate_book: silenced when category set is in acceptable_book_combos', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
        'Book On CD': {
          Author: { Book: { '01 - Chapter.mp3': '' } },
        },
      },
      rules: {
        acceptable_book_combos: [['Audible', 'Book On CD']],
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/Duplicate book found in multiple categories/))
    ).toBe(false)
  })

  it('warn_loose_files: audio files in author folder (no book wrapper)', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { '01 - Chapter.mp3': '' },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/loose audio/i))).toBe(true)
  })

  it('warn_loose_files: audio files at category root', () => {
    const result = runAudiobooksScan({
      spec: { Audible: { '01 - Chapter.mp3': '' } },
    })
    expect(result.warnings.some(w => w.issue.match(/loose audio/i))).toBe(true)
  })

  it('warn_extra_subfolders: nested folder in book folder', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: {
            Book: {
              '01 - Chapter.mp3': '',
              Extras: { '01 - Bonus.mp3': '' },
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected subfolder/))).toBe(true)
  })

  it('warn_unexpected_entries: stray file in book folder', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: {
            Book: {
              '01 - Chapter.mp3': '',
              'notes.txt': '',
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected file/))).toBe(true)
  })

  it('warn_non_primary: non-primary audio file', () => {
    const result = runAudiobooksScan({
      spec: {
        Audible: {
          Author: { Book: { '01 - Chapter.m4b': '' } },
        },
      },
    })
    // primary_extension defaults to [.mp3, .flac]; m4b is not primary.
    expect(result.warnings.some(w => w.issue.match(/Non-.MP3\/.FLAC/))).toBe(true)
  })

  it('toggles silence warnings when set to false', () => {
    const result = runAudiobooksScan({
      spec: { Audible: { '01 - Chapter.mp3': '' } },
      rules: {
        checks: { ...defaultAudiobooksRules.checks, warn_loose_files: false },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/loose audio/i))).toBe(false)
  })
})

describe('audiobooks module — name consistency', () => {
  const spec: DirSpec = {
    Audible: {
      'Eric Nylund': { 'Halo - The Fall of Reach': { '01 - Chapter.mp3': '' } },
      'Troy Denning': { 'Halo - Last Light': { '01 - Chapter.mp3': '' } },
      'Matt Forbeck': { 'HALO - Legacy of Onyx': { '01 - Chapter.mp3': '' } },
    },
  }

  it('emits name warnings at Category/Author/Book', () => {
    const result = runAudiobooksScan({ spec })
    const caseWarnings = result.warnings.filter(w => w.type === 'warn_series_name_case')
    expect(caseWarnings.map(w => w.path)).toEqual(['Audible/Matt Forbeck/HALO - Legacy of Onyx'])
  })

  it('is silenced by a books: ignore entry', () => {
    const result = runAudiobooksScan({ spec, ignored: { books: ['HALO - Legacy of Onyx'] } })
    expect(result.warnings.filter(w => w.type === 'warn_series_name_case')).toEqual([])
  })
})
