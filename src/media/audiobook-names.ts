/**
 * media/audiobook-names.ts
 * ------------------------
 * Library-wide consistency checks for audiobook titles and author names.
 *
 * A dictionary spell check is the wrong tool for an audiobook library — it
 * would drown in proper nouns (Sapkowski, Xenocide, Nylund) while missing the
 * mistakes that actually happen. Those mistakes are INCONSISTENCIES: the same
 * series, prefix, or author written two different ways across books.
 *
 *   Gaunt's Ghost, Book 1   vs  Gaunt's Ghosts, Book 2     series spelling
 *   HALO - Legacy of Onyx   vs  Halo - The Flood           prefix capitalization
 *   Tobias S. Buckell       vs  Tobias Buckell             author spelling
 *   Gaunt’s Ghosts          vs  Gaunt's Ghosts             curly vs straight quote
 *   &quot;Band of Brothers&quot;                           HTML entity left in a name
 *
 * Whichever spelling most books use is treated as canonical, and each book
 * using another spelling gets a warning recommending the rename. Nothing here
 * touches the filesystem — the input is the merged scan records.
 *
 * Pure functions only, so the grouping and classification logic is testable
 * without building a fixture library.
 */

import path from 'path'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** The per-book facts the name checks need. */
export interface NamedBook {
  /** Book folder name, e.g. `Ghostmaker - Gaunt's Ghosts, Book 2`. */
  title: string
  /** Author folder name exactly as on disk, e.g. `Don Malarkey, Bob Welch`. */
  authorFolder: string
  /** Individual author names parsed from the folder. */
  authors: string[]
  /** Categories the book appears in, in configured order. */
  categories: string[]
}

/** The check identifiers this module can emit — each is a `rules.checks` toggle. */
export type NameCheck =
  | 'warn_series_name_mismatch'
  | 'warn_series_name_case'
  | 'warn_author_name_mismatch'
  | 'warn_author_name_case'
  | 'warn_encoded_characters'
  | 'warn_mixed_punctuation'

export interface NameFinding {
  type: NameCheck
  book: NamedBook
  issue: string
  /**
   * The remedy for this check, relayed to `WarningOptions.fix` so it is
   * written once per bucket instead of on every row. Constant per `type` —
   * the per-row suggested rename belongs in `issue`, which is the part that
   * actually differs book to book.
   */
  fix: string
}

/**
 * The remedy for each name check. Kept in one map so every `findings.push`
 * of a given type relays the same text — `WarningCollector.groupedByType()`
 * takes the first it sees and warns if a bucket disagrees with itself.
 */
const FIX: Record<NameCheck, string> = {
  warn_series_name_case: `Rename so one spelling wins — Plex sorts the two apart otherwise.`,
  warn_series_name_mismatch:
    `Rename so one spelling wins, whichever is correct — Plex treats the variants as ` +
    `separate series otherwise.`,
  warn_author_name_case: `Rename so one spelling wins — Plex treats the variants as separate people.`,
  warn_author_name_mismatch:
    `Rename so one spelling wins, whichever is correct — Plex treats differently spelled ` +
    `authors as separate people.`,
  warn_encoded_characters:
    `The folder name has raw HTML entities in it, usually from a download. Rename it to ` +
    `the characters they stand for.`,
  warn_mixed_punctuation:
    `Mixed quote styles make otherwise identical names sort and search differently. ` +
    `Rename to the style the rest of the library uses.`,
}

// ─────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────

/** The separator Plex audiobook folders use between title, subtitle, and series. */
const SEGMENT_SEPARATOR = ' - '

/** `Gaunt's Ghosts, Book 2` / `The Horus Heresy, Book 24` */
const SERIES_BOOK_N = /^(?<series>.+?),\s+(?:Book|Volume|Vol\.)\s+\d+$/i

/** `Book Two in the Dune Chronicles` / `Volume Three of the Ender Saga` */
const BOOK_N_OF_SERIES = /^(?:Book|Volume)\s+\S+\s+(?:in|of)\s+(?<series>.+)$/i

/** A leading English article, dropped so `The Forerunner Saga` and `the Forerunner Saga` group. */
const LEADING_ARTICLE = /^the\s+/i

/**
 * Pull the series name out of a book title, or null when the title doesn't
 * name one. Looks at every ` - ` segment after the first, since the series
 * usually trails the subtitle (`Halo - Primordium - The Forerunner Saga, Book 2`)
 * but not always (`Star Wars - The Thrawn Trilogy, Book 3 - The Last Command`).
 *
 * A leading "The" is dropped from the returned name. Books phrase the same
 * series both ways (`Book One of the Forerunner Saga` / `The Forerunner Saga,
 * Book 2`), and flagging that as capitalization drift would be misleading.
 */
export function parseSeries(title: string): string | null {
  const segments = title.split(SEGMENT_SEPARATOR)
  for (const segment of segments.slice(1)) {
    const match = SERIES_BOOK_N.exec(segment.trim()) ?? BOOK_N_OF_SERIES.exec(segment.trim())
    const series = match?.groups?.series?.trim()
    if (series) return series.replace(LEADING_ARTICLE, '')
  }
  return null
}

/**
 * The franchise prefix — the first ` - ` segment — for titles with more than
 * one segment (`Halo - The Flood` → `Halo`). Null for single-segment titles.
 */
export function parsePrefix(title: string): string | null {
  const segments = title.split(SEGMENT_SEPARATOR)
  return segments.length > 1 ? segments[0]!.trim() : null
}

// ─────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────

/** Curly single quotes/apostrophes and their straight equivalent. */
const CURLY_SINGLE = /[‘’]/g
/** Curly double quotes and their straight equivalent. */
const CURLY_DOUBLE = /[“”]/g

/** Replace curly quotes with straight ones. */
export function foldQuotes(s: string): string {
  return s.replace(CURLY_SINGLE, "'").replace(CURLY_DOUBLE, '"')
}

/** HTML/XML character references — `&quot;`, `&amp;`, `&#39;`, `&#x27;`. */
const ENCODED_ENTITY = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi

/**
 * Grouping key for series names: lowercase, quotes folded, punctuation
 * removed, whitespace collapsed. Two spellings with the same key differ only
 * in case or punctuation.
 */
function seriesKey(s: string): string {
  return foldQuotes(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Grouping key for a person's name. Beyond case and punctuation it folds the
 * two ways the same author gets written:
 *
 *   J.R.R. Tolkien  /  J. R. R. Tolkien   → runs of initials merge: `jrr tolkien`
 *   Tobias S. Buckell  /  Tobias Buckell  → a lone middle initial drops: `tobias buckell`
 *
 * A leading or trailing initial is kept (`E. B. Sledge` → `eb sledge`), so
 * the key never collapses to a bare surname.
 */
export function authorKey(name: string): string {
  const tokens = foldQuotes(name)
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .split(/\s+/)
    .filter(t => t.length > 0)

  // Merge each run of consecutive single-letter tokens into one: j r r → jrr.
  const merged: Array<{ text: string; initials: boolean }> = []
  for (const token of tokens) {
    const last = merged[merged.length - 1]
    if (token.length === 1 && last?.initials) {
      last.text += token
    } else {
      merged.push({ text: token, initials: token.length === 1 })
    }
  }

  // Drop a lone middle initial between two full name parts.
  return merged
    .filter((t, i) => !(t.text.length === 1 && i > 0 && i < merged.length - 1))
    .map(t => t.text)
    .join(' ')
}

/**
 * Levenshtein distance, capped: returns `limit + 1` as soon as the distance
 * is known to exceed `limit`. Series names are short, so the quadratic table
 * is fine; the cap just keeps the intent explicit.
 */
export function editDistance(a: string, b: string, limit = 1): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
      curr.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > limit) return limit + 1
    prev = curr
  }
  return prev[b.length]!
}

/** Shortest key eligible for fuzzy (edit-distance) grouping — below this, near-misses are coincidence. */
const MIN_FUZZY_KEY_LENGTH = 8

/** Do two series keys name the same series? Equal, or one typo apart on a long-enough name. */
function sameSeries(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.min(a.length, b.length) < MIN_FUZZY_KEY_LENGTH) return false
  return editDistance(a, b, 1) <= 1
}

// ─────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────

/** One spelling of a name and the books that use it. */
interface Variant {
  spelling: string
  books: NamedBook[]
}

/**
 * Cluster spellings with a key function and a "same group" predicate. Uses
 * single-link clustering over the distinct keys — fine at library scale
 * (a few hundred names at most).
 */
function cluster(
  occurrences: Array<{ spelling: string; book: NamedBook }>,
  keyOf: (s: string) => string,
  same: (a: string, b: string) => boolean
): Variant[][] {
  const bySpelling = new Map<string, Variant>()
  for (const { spelling, book } of occurrences) {
    let variant = bySpelling.get(spelling)
    if (!variant) {
      variant = { spelling, books: [] }
      bySpelling.set(spelling, variant)
    }
    if (!variant.books.includes(book)) variant.books.push(book)
  }

  const groups: Array<{ keys: string[]; variants: Variant[] }> = []
  for (const variant of [...bySpelling.values()].sort((a, b) =>
    a.spelling.localeCompare(b.spelling)
  )) {
    const key = keyOf(variant.spelling)
    const matching = groups.filter(g => g.keys.some(k => same(k, key)))
    if (matching.length === 0) {
      groups.push({ keys: [key], variants: [variant] })
      continue
    }
    // Merge every group this variant bridges into the first.
    const [target, ...rest] = matching
    target!.keys.push(key)
    target!.variants.push(variant)
    for (const other of rest) {
      target!.keys.push(...other.keys)
      target!.variants.push(...other.variants)
      groups.splice(groups.indexOf(other), 1)
    }
  }

  return groups.filter(g => g.variants.length > 1).map(g => g.variants)
}

/**
 * Pick the canonical spelling in a group: the one the most books use.
 *
 * Ties go first to the spelling whose case- and quote-folded form is most
 * common (so `Gaunt's Ghosts` + `Gaunt’s Ghosts` outvote a lone `Gaunt's
 * Ghost`), then to the library's dominant quote style, then to the longer
 * spelling (`Tobias S. Buckell` over `Tobias Buckell` — the fuller name is
 * the safer rename target), then alphabetically for determinism.
 */
function pickCanonical(variants: Variant[], preferCurly: boolean): Variant {
  const foldedCounts = new Map<string, number>()
  for (const v of variants) {
    const folded = foldQuotes(v.spelling).toLowerCase()
    foldedCounts.set(folded, (foldedCounts.get(folded) ?? 0) + v.books.length)
  }
  const hasCurly = (s: string) => /[‘’“”]/.test(s)

  return [...variants].sort((a, b) => {
    const folded =
      foldedCounts.get(foldQuotes(b.spelling).toLowerCase())! -
      foldedCounts.get(foldQuotes(a.spelling).toLowerCase())!
    if (folded !== 0) return folded
    if (b.books.length !== a.books.length) return b.books.length - a.books.length
    const quoteStyle =
      Number(hasCurly(b.spelling) === preferCurly) - Number(hasCurly(a.spelling) === preferCurly)
    if (quoteStyle !== 0) return quoteStyle
    if (b.spelling.length !== a.spelling.length) return b.spelling.length - a.spelling.length
    return a.spelling.localeCompare(b.spelling)
  })[0]!
}

/** How a non-canonical spelling differs from the canonical one. */
function classify(variant: string, canonical: string): 'case' | 'punctuation' | 'mismatch' {
  if (variant.toLowerCase() === canonical.toLowerCase()) return 'case'
  if (foldQuotes(variant) === foldQuotes(canonical)) return 'punctuation'
  return 'mismatch'
}

// ─────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────

/** `Category/Author/Title` for a book, dropping the synthetic `default` category. */
export function bookWarningPath(book: NamedBook): string {
  const category = book.categories[0]
  return category && category !== 'default'
    ? path.join(category, book.authorFolder, book.title)
    : path.join(book.authorFolder, book.title)
}

/** Quote a short list of book titles for a message, truncating long lists. */
function listTitles(books: NamedBook[], max = 3): string {
  const titles = books.slice(0, max).map(b => `'${b.title}'`)
  const more = books.length > max ? `, +${books.length - max} more` : ''
  return titles.join(', ') + more
}

/** `n book(s)` */
function bookCount(n: number): string {
  return `${n} book${n === 1 ? '' : 's'}`
}

// ─────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────

/**
 * Series and prefix drift. Series names are clustered fuzzily (punctuation,
 * case, one typo); prefixes only by exact case-insensitive key, because short
 * first segments one letter apart are usually genuinely different books.
 */
function checkSeries(books: NamedBook[], preferCurly: boolean): NameFinding[] {
  const findings: NameFinding[] = []

  const seriesOccurrences = books.flatMap(book => {
    const series = parseSeries(book.title)
    return series ? [{ spelling: series, book }] : []
  })
  const prefixOccurrences = books.flatMap(book => {
    const prefix = parsePrefix(book.title)
    return prefix ? [{ spelling: prefix, book }] : []
  })

  const report = (groups: Variant[][], label: 'Series' | 'Title prefix') => {
    for (const group of groups) {
      const canonical = pickCanonical(group, preferCurly)
      for (const variant of group) {
        if (variant === canonical) continue
        const kind = classify(variant.spelling, canonical.spelling)
        // Quote-style-only differences are reported library-wide by
        // warn_mixed_punctuation; reporting them here too would double up.
        if (kind === 'punctuation') continue

        for (const book of variant.books) {
          const suggested = book.title.split(variant.spelling).join(canonical.spelling)
          const others = `${bookCount(canonical.books.length)} (${listTitles(canonical.books)})`
          if (kind === 'case') {
            findings.push({
              type: 'warn_series_name_case',
              book,
              issue:
                `${label} is capitalized '${variant.spelling}' here, '${canonical.spelling}' in ${others}. ` +
                `Rename to '${suggested}'.`,
              fix: FIX.warn_series_name_case,
            })
          } else {
            findings.push({
              type: 'warn_series_name_mismatch',
              book,
              issue:
                `${label} is written '${variant.spelling}' here, '${canonical.spelling}' in ${others}. ` +
                `Rename to '${suggested}'.`,
              fix: FIX.warn_series_name_mismatch,
            })
          }
        }
      }
    }
  }

  report(cluster(seriesOccurrences, seriesKey, sameSeries), 'Series')
  // Prefixes: case-only grouping. Anything else would pair unrelated titles.
  report(
    cluster(
      prefixOccurrences,
      s => s.toLowerCase(),
      (a, b) => a === b
    ),
    'Title prefix'
  )
  return findings
}

/** The same author written two ways, across every book they appear on. */
function checkAuthors(books: NamedBook[], preferCurly: boolean): NameFinding[] {
  const findings: NameFinding[] = []
  const occurrences = books.flatMap(book => book.authors.map(spelling => ({ spelling, book })))

  for (const group of cluster(occurrences, authorKey, (a, b) => a === b)) {
    const canonical = pickCanonical(group, preferCurly)
    for (const variant of group) {
      if (variant === canonical) continue
      const kind = classify(variant.spelling, canonical.spelling)
      if (kind === 'punctuation') continue

      for (const book of variant.books) {
        const suggested = book.authorFolder.split(variant.spelling).join(canonical.spelling)
        const others = `${bookCount(canonical.books.length)} (${listTitles(canonical.books)})`
        findings.push({
          type: kind === 'case' ? 'warn_author_name_case' : 'warn_author_name_mismatch',
          book,
          issue:
            `Author is ${kind === 'case' ? 'capitalized' : 'written'} '${variant.spelling}' here, ` +
            `'${canonical.spelling}' on ${others}. Rename to '${suggested}'.`,
          fix: kind === 'case' ? FIX.warn_author_name_case : FIX.warn_author_name_mismatch,
        })
      }
    }
  }
  return findings
}

/** HTML entities like `&quot;` left in a folder name by whatever tool downloaded it. */
function checkEncodedCharacters(books: NamedBook[]): NameFinding[] {
  const decode: Record<string, string> = {
    '&quot;': '"',
    '&amp;': '&',
    '&apos;': "'",
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
  }
  const findings: NameFinding[] = []
  for (const book of books) {
    const entities = new Set([
      ...(book.title.match(ENCODED_ENTITY) ?? []),
      ...(book.authorFolder.match(ENCODED_ENTITY) ?? []),
    ])
    if (entities.size === 0) continue

    const inTitle = ENCODED_ENTITY.test(book.title)
    ENCODED_ENTITY.lastIndex = 0
    const where = inTitle ? 'book folder' : 'author folder'
    const name = inTitle ? book.title : book.authorFolder
    // Decode, then fall back to deleting anything that isn't legal on disk.
    const suggested = name
      .replace(ENCODED_ENTITY, e => decode[e.toLowerCase()] ?? '')
      .replace(/"/g, "'")
      .replace(/[<>]/g, '')
    findings.push({
      type: 'warn_encoded_characters',
      book,
      issue: `The ${where} name has HTML entities (${[...entities].join(', ')}). Rename to '${suggested}'.`,
      fix: FIX.warn_encoded_characters,
    })
  }
  return findings
}

/**
 * Curly vs straight quotes. Counts the books using each style across titles
 * and author folders, and flags books in the minority style. A tie flags
 * nothing — there's no majority to recommend.
 *
 * Returns the dominant style too, so canonical-spelling tiebreaks elsewhere
 * can prefer it.
 */
function checkPunctuation(books: NamedBook[]): { findings: NameFinding[]; preferCurly: boolean } {
  const text = (b: NamedBook) => `${b.authorFolder}/${b.title}`.replace(ENCODED_ENTITY, '')
  const curlyBooks = books.filter(b => /[‘’“”]/.test(text(b)))
  const straightBooks = books.filter(b => /['"]/.test(text(b)))
  const preferCurly = curlyBooks.length > straightBooks.length

  const findings: NameFinding[] = []
  if (curlyBooks.length === straightBooks.length) return { findings, preferCurly }

  const minority = preferCurly ? straightBooks : curlyBooks
  const majorityCount = preferCurly ? curlyBooks.length : straightBooks.length
  for (const book of minority) {
    // A book using both styles is only in the minority for its minority half.
    const inTitle = preferCurly ? /['"]/.test(book.title) : /[‘’“”]/.test(book.title)
    const name = inTitle ? book.title : book.authorFolder
    const suggested = preferCurly ? name.replace(/'/g, '’').replace(/"/g, '”') : foldQuotes(name)
    findings.push({
      type: 'warn_mixed_punctuation',
      book,
      issue:
        `The ${inTitle ? 'book' : 'author'} folder uses ${preferCurly ? 'straight' : 'curly'} quotes; ` +
        `${bookCount(majorityCount)} use ${preferCurly ? 'curly' : 'straight'}. Rename to '${suggested}'.`,
      fix: FIX.warn_mixed_punctuation,
    })
  }
  return { findings, preferCurly }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

/**
 * Run every name check whose toggle is on. At most one finding per
 * (type, book) — a book in two drifting groups of the same kind gets one
 * warning carrying the first message, so warnings.json stays one row per
 * book per check.
 */
export function findNameIssues(
  books: NamedBook[],
  enabled: Record<NameCheck, boolean>
): NameFinding[] {
  const punctuation = checkPunctuation(books)
  const all = [
    ...checkSeries(books, punctuation.preferCurly),
    ...checkAuthors(books, punctuation.preferCurly),
    ...checkEncodedCharacters(books),
    ...punctuation.findings,
  ]

  const seen = new Set<string>()
  return all.filter(f => {
    if (!enabled[f.type]) return false
    const key = `${f.type}|${f.book.authorFolder}|${f.book.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
