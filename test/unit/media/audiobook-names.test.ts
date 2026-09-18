import { describe, it, expect } from 'vitest'

import {
  authorKey,
  bookWarningPath,
  editDistance,
  findNameIssues,
  parsePrefix,
  parseSeries,
  type NameCheck,
  type NamedBook,
} from '../../../src/media/audiobook-names'

const ALL_ON: Record<NameCheck, boolean> = {
  warn_series_name_mismatch: true,
  warn_series_name_case: true,
  warn_author_name_mismatch: true,
  warn_author_name_case: true,
  warn_encoded_characters: true,
  warn_mixed_punctuation: true,
}

function book(authorFolder: string, title: string, categories = ['Audible']): NamedBook {
  return {
    title,
    authorFolder,
    authors: authorFolder.split(', '),
    categories,
  }
}

function issues(books: NamedBook[], enabled = ALL_ON) {
  return findNameIssues(books, enabled).map(f => ({ type: f.type, title: f.book.title }))
}

describe('parseSeries', () => {
  it('reads a trailing "<Series>, Book N" segment', () => {
    expect(parseSeries("Ghostmaker - Gaunt's Ghosts, Book 2")).toBe("Gaunt's Ghosts")
  })

  it('drops a leading "The"', () => {
    expect(parseSeries('Horus Rising - The Horus Heresy, Book 1')).toBe('Horus Heresy')
  })

  it('reads "Book N in/of <Series>" phrasing', () => {
    expect(parseSeries('Dune Messiah - Book Two in the Dune Chronicles')).toBe('Dune Chronicles')
    expect(parseSeries('Xenocide - Volume Three of the Ender Saga')).toBe('Ender Saga')
  })

  it('finds the series in a middle segment', () => {
    expect(parseSeries('Star Wars - The Thrawn Trilogy, Book 3 - The Last Command')).toBe(
      'Thrawn Trilogy'
    )
  })

  it('returns null when no segment names a series', () => {
    expect(parseSeries('The Hobbit')).toBeNull()
    expect(parseSeries('Halo - The Flood')).toBeNull()
  })
})

describe('parsePrefix', () => {
  it('returns the first segment of a multi-segment title', () => {
    expect(parsePrefix('Halo - The Flood')).toBe('Halo')
  })

  it('returns null for a single-segment title', () => {
    expect(parsePrefix('Dune')).toBeNull()
  })

  it('does not split on an unspaced hyphen', () => {
    expect(parsePrefix('Half-Blood Prince')).toBeNull()
  })
})

describe('authorKey', () => {
  it('folds spaced and unspaced initials together', () => {
    expect(authorKey('J.R.R. Tolkien')).toBe(authorKey('J. R. R. Tolkien'))
  })

  it('drops a lone middle initial', () => {
    expect(authorKey('Tobias S. Buckell')).toBe(authorKey('Tobias Buckell'))
  })

  it('keeps leading initials so the key is never a bare surname', () => {
    expect(authorKey('E. B. Sledge')).toBe('eb sledge')
  })

  it('keeps genuinely different first names apart', () => {
    expect(authorKey('Eric Nylund')).not.toBe(authorKey('Erik Nylund'))
  })
})

describe('editDistance', () => {
  it('measures single edits', () => {
    expect(editDistance("gaunt's ghost", "gaunt's ghosts")).toBe(1)
  })

  it('caps at limit + 1', () => {
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2)
  })
})

describe('findNameIssues — series', () => {
  it('flags a plural typo against the majority spelling', () => {
    const books = [
      book('Dan Abnett', "First and Only - Gaunt's Ghost, Book 1"),
      book('Dan Abnett', "Ghostmaker - Gaunt's Ghosts, Book 2"),
      book('Dan Abnett', "Necropolis - Gaunt's Ghosts, Book 3"),
    ]
    const findings = findNameIssues(books, ALL_ON)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.type).toBe('warn_series_name_mismatch')
    expect(findings[0]!.book.title).toBe("First and Only - Gaunt's Ghost, Book 1")
    expect(findings[0]!.issue).toContain("Rename to 'First and Only - Gaunt's Ghosts, Book 1'")
  })

  it('lets quote-folded spellings outvote a lone typo when counts tie', () => {
    const books = [
      book('Dan Abnett', "First and Only - Gaunt's Ghost, Book 1"),
      book('Dan Abnett', "Ghostmaker - Gaunt's Ghosts, Book 2"),
      book('Dan Abnett', 'Necropolis - Gaunt’s Ghosts, Book 3'),
    ]
    const series = findNameIssues(books, ALL_ON).filter(f => f.type === 'warn_series_name_mismatch')
    expect(series.map(f => f.book.title)).toEqual(["First and Only - Gaunt's Ghost, Book 1"])
  })

  it('flags capitalization-only prefix drift separately', () => {
    expect(
      issues([
        book('Eric Nylund', 'Halo - The Fall of Reach'),
        book('Troy Denning', 'Halo - Last Light'),
        book('Matt Forbeck', 'HALO - Legacy of Onyx'),
      ])
    ).toEqual([{ type: 'warn_series_name_case', title: 'HALO - Legacy of Onyx' }])
  })

  it('does not fuzzy-match short prefixes', () => {
    expect(issues([book('A', 'Dune - One'), book('B', 'June - Two')])).toEqual([])
  })

  it('does not treat "The X Saga" and "the X Saga" phrasing as drift', () => {
    expect(
      issues([
        book('Greg Bear', 'Halo - Cryptum - Book One of the Forerunner Saga'),
        book('Greg Bear', 'Halo - Primordium - The Forerunner Saga, Book 2'),
      ])
    ).toEqual([])
  })

  it('stays quiet for a consistent library', () => {
    expect(
      issues([
        book('Dan Abnett', 'Horus Rising - The Horus Heresy, Book 1'),
        book('Graham McNeill', 'False Gods - The Horus Heresy, Book 2'),
      ])
    ).toEqual([])
  })
})

describe('findNameIssues — authors', () => {
  it('flags an author written two ways, including inside a multi-author folder', () => {
    const books = [
      book('Tobias S. Buckell', 'Halo - Envoy'),
      book('Tobias S. Buckell', 'Halo - The Cole Protocol'),
      book('Tobias Buckell, Eric Nylund', 'Halo - Evolutions'),
    ]
    const findings = findNameIssues(books, ALL_ON)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.type).toBe('warn_author_name_mismatch')
    expect(findings[0]!.issue).toContain("Rename to 'Tobias S. Buckell, Eric Nylund'")
  })

  it('flags capitalization-only author drift as the case variant', () => {
    expect(
      issues([
        book('Andy Weir', 'The Martian'),
        book('Andy Weir', 'Project Hail Mary'),
        book('andy weir', 'Artemis'),
      ])
    ).toEqual([{ type: 'warn_author_name_case', title: 'Artemis' }])
  })
})

describe('findNameIssues — characters', () => {
  it('flags HTML entities and suggests the decoded name', () => {
    const findings = findNameIssues(
      [book('Don Malarkey, Bob Welch', 'Easy Company Soldier - The &quot;Band of Brothers&quot;')],
      ALL_ON
    )
    expect(findings.map(f => f.type)).toEqual(['warn_encoded_characters'])
    expect(findings[0]!.issue).toContain("'Easy Company Soldier - The 'Band of Brothers''")
  })

  it('flags the minority quote style', () => {
    expect(
      issues([
        book('Orson Scott Card', "Ender's Game"),
        book('J.K. Rowling', "Harry Potter and the Sorcerer's Stone, Book 1"),
        book('Donald L. Miller', 'Masters of the Air - America’s Bomber Boys'),
      ])
    ).toEqual([
      { type: 'warn_mixed_punctuation', title: 'Masters of the Air - America’s Bomber Boys' },
    ])
  })

  it('does not flag a quote-style tie', () => {
    expect(issues([book('A', "Ender's Game"), book('B', 'America’s War')])).toEqual([])
  })

  it('leaves full-width substitutes for filename-illegal characters alone', () => {
    expect(
      issues([
        book('Philip K. Dick', 'Blade Runner - Do Androids Dream of Electric Sheep？'),
        book('Jared Frederick', 'Hang Tough꞉ The WWII Letters'),
      ])
    ).toEqual([])
  })
})

describe('findNameIssues — toggles and paths', () => {
  it('omits findings whose toggle is off', () => {
    const books = [
      book('Eric Nylund', 'Halo - The Fall of Reach'),
      book('Troy Denning', 'Halo - Last Light'),
      book('Matt Forbeck', 'HALO - Legacy of Onyx'),
    ]
    expect(issues(books, { ...ALL_ON, warn_series_name_case: false })).toEqual([])
  })

  it('builds Category/Author/Title paths, dropping the default category', () => {
    expect(bookWarningPath(book('Andy Weir', 'The Martian', ['Audible']))).toMatch(
      /^Audible[\\/]Andy Weir[\\/]The Martian$/
    )
    expect(bookWarningPath(book('Andy Weir', 'The Martian', ['default']))).toMatch(
      /^Andy Weir[\\/]The Martian$/
    )
  })
})
