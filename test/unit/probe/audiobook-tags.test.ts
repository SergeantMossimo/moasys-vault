import { describe, it, expect } from 'vitest'

import {
  analyzeBookTags,
  compareAuthors,
  compareBookTitle,
  comparableTitle,
  splitAuthors,
  type BookTagCheck,
  type BookTags,
} from '../../../src/probe/audiobook-tags'
import type { TagData } from '../../../src/probe/types'

const ALL_ON: Record<BookTagCheck, boolean> = {
  warn_book_tag_mismatch: true,
  warn_book_tag_case: true,
  warn_author_tag_mismatch: true,
  warn_author_tag_case: true,
  warn_missing_book_tags: true,
}

function tag(album: string | null, artist: string | null): TagData {
  return {
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
  }
}

function bookWith(title: string, authorFolder: string, tags: Array<TagData | null>): BookTags {
  return { title, authorFolder, authors: splitAuthors(authorFolder), tags }
}

describe('comparableTitle', () => {
  it('drops the Audible edition marker', () => {
    expect(comparableTitle('The Oath (Unabridged)')).toBe('The Oath')
  })

  it('reads a subtitle colon as the folder separator', () => {
    expect(comparableTitle('Halo: The Flood')).toBe('Halo - The Flood')
  })

  it('maps full-width stand-ins back before stripping illegal characters', () => {
    expect(comparableTitle('Electric Sheep？')).toBe(comparableTitle('Electric Sheep?'))
  })

  it('folds curly quotes', () => {
    expect(comparableTitle('A Small Boy’s Journey')).toBe("A Small Boy's Journey")
  })
})

describe('compareBookTitle', () => {
  it('matches when the folder adds a series suffix', () => {
    expect(
      compareBookTitle(
        'A Clash of Kings (Unabridged)',
        'A Clash of Kings - A Song of Ice and Fire, Book 2'
      )
    ).toBe('match')
  })

  it('matches when the tag adds a series suffix', () => {
    expect(
      compareBookTitle('Halo: Broken Circle: Halo, Book 13 (Unabridged)', 'Halo - Broken Circle')
    ).toBe('match')
  })

  it('does not match a mere string prefix without a separator', () => {
    expect(compareBookTitle('Dune', 'Dune Messiah')).toBe('mismatch')
  })

  it('reports capitalization-only differences', () => {
    expect(compareBookTitle('HALO: Envoy (Unabridged)', 'Halo - Envoy')).toBe('case-only')
  })

  it('reports reordered titles as a mismatch', () => {
    expect(
      compareBookTitle("Saint's Testimony: HALO (Unabridged)", "Halo - Saint's Testimony")
    ).toBe('mismatch')
  })
})

describe('splitAuthors / compareAuthors', () => {
  it('drops role suffixes', () => {
    expect(splitAuthors('Andrzej Sapkowski, Danusia Stok - translator')).toEqual([
      'Andrzej Sapkowski',
      'Danusia Stok',
    ])
  })

  it('ignores author order', () => {
    expect(compareAuthors('Kevin Grace, Tobias Buckell', ['Tobias Buckell', 'Kevin Grace'])).toBe(
      'match'
    )
  })

  it('reports case-only author differences', () => {
    expect(compareAuthors('andy weir', ['Andy Weir'])).toBe('case-only')
  })

  it('treats spacing between initials as a mismatch', () => {
    expect(compareAuthors('George R.R. Martin', ['George R. R. Martin'])).toBe('mismatch')
  })
})

describe('analyzeBookTags', () => {
  it('is silent when tags agree with the folders', () => {
    const book = bookWith('The Martian', 'Andy Weir', [
      tag('The Martian (Unabridged)', 'Andy Weir'),
    ])
    expect(analyzeBookTags(book, ALL_ON)).toEqual([])
  })

  it('compares the value most chapters carry, not a stray chapter', () => {
    const book = bookWith('The Martian', 'Andy Weir', [
      tag('The Martian', 'Andy Weir'),
      tag('The Martian', 'Andy Weir'),
      tag('Artemis', 'Andy Weir'),
    ])
    expect(analyzeBookTags(book, ALL_ON)).toEqual([])
  })

  it('flags a misspelled author tag', () => {
    const findings = analyzeBookTags(
      bookWith('Halo - Battle Born', 'Cassandra Rose Clarke', [
        tag('Halo: Battle Born', 'Cassandra Rose Clark'),
      ]),
      ALL_ON
    )
    expect(findings.map(f => f.type)).toEqual(['warn_author_tag_mismatch'])
    expect(findings[0]!.issue).toContain("'Cassandra Rose Clark'")
  })

  it('notes when an author mismatch is only initials or spacing', () => {
    const findings = analyzeBookTags(
      bookWith('A Game of Thrones', 'George R. R. Martin', [
        tag('A Game of Thrones', 'George R.R. Martin'),
      ]),
      ALL_ON
    )
    expect(findings[0]!.issue).toContain('different initials or spacing')
  })

  it('flags a book whose chapters have no tags at all', () => {
    const findings = analyzeBookTags(bookWith('The Oath', 'Frank E. Peretti', [null, null]), ALL_ON)
    expect(findings.map(f => f.type)).toEqual(['warn_missing_book_tags'])
  })

  it('respects toggles', () => {
    const book = bookWith('Halo - Envoy', 'Tobias S. Buckell', [
      tag('HALO: Envoy', 'Tobias S. Buckell'),
    ])
    expect(analyzeBookTags(book, { ...ALL_ON, warn_book_tag_case: false })).toEqual([])
  })
})
