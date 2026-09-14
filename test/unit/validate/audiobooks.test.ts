import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { bookTitleOnly, resolveBook, validateAudiobooks } from '../../../src/validate/audiobooks'
import { defaultAudiobooksRules, type AudiobooksRules } from '../../../src/core/rules/audiobooks'
import { JsonCache } from '../../../src/validate/cache'
import { WarningCollector, type BookOutput } from '../../../src/core/types'
import type { OpenLibraryClient, OpenLibraryDoc } from '../../../src/validate/openlibrary'

function memoryCache<T>(seed: Record<string, T> = {}): JsonCache<T> {
  const cache = new JsonCache<T>('/dev/null-' + Math.random().toString(36))
  for (const [k, v] of Object.entries(seed)) cache.set(k, v)
  return cache
}

function doc(title: string, authors: string[], subtitle?: string): OpenLibraryDoc {
  return { key: `/works/${title}`, title, subtitle, author_name: authors }
}

function book(title: string, authors: string[]): BookOutput {
  return { title, authors, chapter_count: 1, versions: [{ category: 'Audible', quality: 'MP3' }] }
}

/** A client whose search returns `results` for queries containing a given author (or any). */
function mockClient(respond: (query: string, author?: string) => OpenLibraryDoc[]) {
  const search = vi.fn(async (query: string, author?: string) => respond(query, author))
  return { client: { search, totalRequests: 0 } as unknown as OpenLibraryClient, search }
}

describe('bookTitleOnly', () => {
  it('drops series segments', () => {
    expect(bookTitleOnly("Ghostmaker - Gaunt's Ghosts, Book 2")).toBe('Ghostmaker')
    expect(bookTitleOnly('Dune Messiah - Book Two in the Dune Chronicles')).toBe('Dune Messiah')
  })

  it('drops a trailing ", Book N" inside the last segment', () => {
    expect(bookTitleOnly("Harry Potter and the Sorcerer's Stone, Book 1")).toBe(
      "Harry Potter and the Sorcerer's Stone"
    )
  })

  it('drops all-parenthetical edition segments', () => {
    expect(
      bookTitleOnly(
        'Star Wars - Heir to the Empire - (20th Anniversary Edition), The Thrawn Trilogy, Book 1'
      )
    ).toBe('Star Wars - Heir to the Empire')
  })

  it('keeps subtitles', () => {
    expect(bookTitleOnly('Jurassic Park - A Novel')).toBe('Jurassic Park - A Novel')
  })
})

describe('resolveBook', () => {
  it('matches when any edition has the exact title and a shared author', () => {
    const docs = [
      doc('Blue ocean strategy', ['W. Chan Kim']),
      doc('Blue Ocean Strategy', ['W. Chan Kim']),
    ]
    expect(resolveBook('Blue Ocean Strategy', ['W. Chan Kim'], docs).status).toBe('matched')
  })

  it('matches across title/subtitle and colon/dash differences', () => {
    const docs = [doc('We Are Legion', ['Dennis E. Taylor'], '(We Are Bob)')]
    expect(
      resolveBook('We Are Legion (We Are Bob) - Bobiverse, Book 1', ['Dennis E. Taylor'], docs)
        .status
    ).toBe('matched')
  })

  it('matches a prefixed title Open Library files without the prefix', () => {
    const docs = [doc('Silentium', ['Greg Bear'])]
    expect(
      resolveBook('Halo - Silentium - The Forerunner Saga, Book 3', ['Greg Bear'], docs).status
    ).toBe('matched')
  })

  it('matches titles padded with series text', () => {
    const docs = [doc('Star Wars - Thrawn Trilogy - Dark Force Rising', ['Timothy Zahn'])]
    expect(
      resolveBook(
        'Star Wars - Dark Force Rising - The Thrawn Trilogy, Book 2',
        ['Timothy Zahn'],
        docs
      ).status
    ).toBe('matched')
  })

  it('folds initials when comparing authors', () => {
    const docs = [doc('The Hobbit', ['J.R.R. Tolkien'])]
    expect(resolveBook('The Hobbit', ['J. R. R. Tolkien'], docs).status).toBe('matched')
  })

  it('reports a typo as close', () => {
    const docs = [doc('Ghostmaker', ['Dan Abnett'])]
    const result = resolveBook('Ghostmakr', ['Dan Abnett'], docs)
    expect(result.status).toBe('close')
    expect(result.doc?.title).toBe('Ghostmaker')
  })

  it('reports a title match with no shared author as author_mismatch', () => {
    const docs = [doc('Halo: Battle Born', ['Cassandra Rose Clarke'])]
    expect(resolveBook('Halo - Battle Born', ['Cassandra Rose Clark'], docs).status).toBe(
      'author_mismatch'
    )
  })

  it('prefers a same-author close match over another author exact match', () => {
    const docs = [doc('Ghostmakr', ['Someone Else']), doc('Ghostmaker', ['Dan Abnett'])]
    expect(resolveBook('Ghostmakr', ['Dan Abnett'], docs).status).toBe('close')
  })

  it('reports unrelated results as not_found', () => {
    const docs = [doc('Krew elfów', ['Andrzej Sapkowski'])]
    expect(resolveBook('Blood of Elves', ['Andrzej Sapkowski'], docs).status).toBe('not_found')
  })
})

describe('validateAudiobooks', () => {
  let warnings: WarningCollector
  let errorSpy: ReturnType<typeof vi.spyOn>
  const rules: AudiobooksRules = { ...defaultAudiobooksRules, categories: [{ name: 'Audible' }] }

  beforeEach(() => {
    warnings = new WarningCollector()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('warns on a probable typo with the Open Library title in the message', async () => {
    const { client } = mockClient(() => [doc('Ghostmaker', ['Dan Abnett'])])
    const out = await validateAudiobooks(
      [book("Ghostmakr - Gaunt's Ghosts, Book 2", ['Dan Abnett'])],
      rules,
      client,
      memoryCache(),
      warnings
    )
    expect(out[0]!.status).toBe('close')
    expect(out[0]!.openlibrary_title).toBe('Ghostmaker')
    const rows = warnings.all()
    expect(rows.map(w => [w.type, w.path])).toEqual([
      ['warn_openlibrary_title_mismatch', "Audible/Dan Abnett/Ghostmakr - Gaunt's Ghosts, Book 2"],
    ])
    expect(rows[0]!.issue).toContain("'Ghostmaker'")
  })

  it('falls back to a title-only search when the author query finds nothing', async () => {
    const { client, search } = mockClient((_q, author) =>
      author ? [] : [doc('Halo: Battle Born', ['Cassandra Rose Clarke'])]
    )
    const out = await validateAudiobooks(
      [book('Halo - Battle Born', ['Cassandra Rose Clark'])],
      rules,
      client,
      memoryCache(),
      warnings
    )
    expect(search).toHaveBeenCalledTimes(2)
    expect(out[0]!.status).toBe('author_mismatch')
    expect(warnings.all().map(w => w.type)).toEqual(['warn_openlibrary_author_mismatch'])
  })

  it('serves repeat queries from the cache', async () => {
    const cache = memoryCache<OpenLibraryDoc[]>()
    const first = mockClient(() => [doc('The Martian', ['Andy Weir'])])
    await validateAudiobooks(
      [book('The Martian', ['Andy Weir'])],
      rules,
      first.client,
      cache,
      warnings
    )
    const second = mockClient(() => [])
    await validateAudiobooks(
      [book('The Martian', ['Andy Weir'])],
      rules,
      second.client,
      cache,
      warnings
    )
    expect(second.search).not.toHaveBeenCalled()
  })

  it('does not warn on not_found while that check is off by default', async () => {
    const { client } = mockClient(() => [])
    const out = await validateAudiobooks(
      [book('Blood of Elves', ['Andrzej Sapkowski'])],
      rules,
      client,
      memoryCache(),
      warnings
    )
    expect(out[0]!.status).toBe('not_found')
    expect(warnings.all()).toEqual([])
  })

  it('treats a failed search as no result rather than aborting', async () => {
    const client = {
      search: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as OpenLibraryClient
    const out = await validateAudiobooks(
      [book('The Martian', ['Andy Weir'])],
      rules,
      client,
      memoryCache(),
      warnings
    )
    expect(out[0]!.status).toBe('not_found')
  })
})
