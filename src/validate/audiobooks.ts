/**
 * validate/audiobooks.ts
 * ----------------------
 * Per-book Open Library validation. For each book in the scan output:
 *   1. Search Open Library by title + first author, falling back to title
 *      alone and then to the title's first segment. Raw results are cached.
 *   2. Compare the folder title against EVERY result, not just the first.
 *      Open Library holds many editions of a book with inconsistent titles
 *      (`The Flood (Halo)`, `Halo` + subtitle `the flood`, `Blue ocean
 *      strategy`), so one matching edition is enough to call the title good.
 *   3. Emit a warning only when nothing matches but something comes close —
 *      the shape of a typo — or when the title matches but the author doesn't.
 *
 * This is a spelling check against a catalog, not an authority on naming.
 * Open Library is community-edited and its coverage of tie-in fiction is
 * patchy, so "not found" defaults off and messages ask the user to verify
 * rather than rename.
 */

import { BookOutput, WarningCollector } from '../core/types'
import { AudiobooksRules } from '../core/rules/audiobooks'
import { authorKey, editDistance } from '../media/audiobook-names'
import { comparableTitle } from '../probe/audiobook-tags'

import { JsonCache } from './cache'
import { categoriesOf, normalizeTitleLoose, stripFilenameIllegalChars } from './helpers'
import { OpenLibraryClient, OpenLibraryDoc } from './openlibrary'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Cache schema version for `cache/openlibrary-search.json`. */
export const OPENLIBRARY_CACHE_VERSION = 1

export type BookValidationStatus = 'matched' | 'case' | 'close' | 'author_mismatch' | 'not_found'

/** One entry in output/<drive>/audiobooks/validation.json. */
export interface BookValidation {
  title: string
  authors: string[]
  status: BookValidationStatus
  /** Open Library work key of the best result, e.g. `/works/OL82563W`. */
  openlibrary_key: string | null
  /** The best result's title, with its subtitle joined as `Title: Subtitle`. */
  openlibrary_title: string | null
  openlibrary_authors: string[]
  first_publish_year: number | null
}

// ─────────────────────────────────────────────
// Query building
// ─────────────────────────────────────────────

/** `Gaunt's Ghosts, Book 2` / `Book Two in the Dune Chronicles` — a whole segment naming the series. */
const SERIES_SEGMENT =
  /^(?:.+?,\s+(?:Book|Volume|Vol\.)\s+\d+|(?:Book|Volume)\s+\S+\s+(?:in|of)\s+.+)$/i

/** A trailing `, Book 1` inside a segment — `Harry Potter and the Sorcerer's Stone, Book 1`. */
const TRAILING_BOOK_N = /,\s+(?:Book|Volume|Vol\.)\s+\d+$/i

/** A segment that is entirely parenthetical — `(20th Anniversary Edition)`. */
const PARENTHETICAL_SEGMENT = /^\(.*\)$/

/**
 * The part of a folder title that names the book itself: series segments,
 * all-parenthetical edition segments, and trailing `, Book N` markers removed.
 * Returned as ` - `-joined segments.
 */
export function bookTitleOnly(folderTitle: string): string {
  const segments = folderTitle
    .split(' - ')
    .map(s => s.replace(/^\(.*?\),\s*/, '').trim())
    .filter((s, i) => i === 0 || !(SERIES_SEGMENT.test(s) || PARENTHETICAL_SEGMENT.test(s)))
  const last = segments.length - 1
  segments[last] = segments[last]!.replace(TRAILING_BOOK_N, '')
  return segments.join(' - ')
}

// ─────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────

type TitleRelation = 'exact' | 'case' | 'close' | 'none'

const RELATION_RANK: Record<TitleRelation, number> = { exact: 0, case: 1, close: 2, none: 3 }

/** Largest edit distance still treated as a probable typo rather than a different book. */
const MAX_TYPO_DISTANCE = 2

/** A trailing parenthetical — Open Library often appends the series: `The Flood (Halo)`. */
const TRAILING_PARENTHETICAL = /\s*\([^)]*\)\s*$/

/** Every title form a result could reasonably be written as. */
function docTitleForms(doc: OpenLibraryDoc): string[] {
  const forms = [doc.title]
  if (doc.subtitle) forms.push(`${doc.title}: ${doc.subtitle}`)
  const bare = doc.title.replace(TRAILING_PARENTHETICAL, '')
  if (bare !== doc.title) forms.push(bare)
  return forms
}

/** Shortest loose title eligible for typo (edit-distance) matching. */
const MIN_TYPO_LENGTH = 6

/**
 * How a local title relates to one title form:
 *
 *   exact  equal once normalized — or, ignoring case and punctuation, one
 *          contains the other at word boundaries. Open Library pads titles
 *          with series text in every arrangement (`Star Wars - Thrawn Trilogy
 *          - Dark Force Rising`, `The First Heretic  Warhammer 40000 Novels`),
 *          and a difference there says nothing about the folder's spelling.
 *   case   equal apart from capitalization.
 *   close  a typo's distance apart.
 *
 * Containment errs toward silence: `Dune` is contained in `Children of Dune`,
 * which can hide a typo warning but never raises a false one.
 */
function relate(local: string, form: string): TitleRelation {
  const a = comparableTitle(local)
  const b = comparableTitle(form)
  if (a === b) return 'exact'
  if (a.toLowerCase() === b.toLowerCase()) return 'case'

  const al = normalizeTitleLoose(a)
  const bl = normalizeTitleLoose(b)
  const within = (x: string, y: string) => ` ${y} `.includes(` ${x} `)
  if (within(al, bl) || within(bl, al)) return 'exact'

  if (
    Math.min(al.length, bl.length) >= MIN_TYPO_LENGTH &&
    editDistance(al, bl, MAX_TYPO_DISTANCE) <= MAX_TYPO_DISTANCE
  ) {
    return 'close'
  }
  return 'none'
}

/**
 * Every form the local title could appear as: the book title itself, and —
 * for a prefixed title like `Halo - Silentium` — the title without its
 * franchise prefix, since Open Library often files it as just `Silentium`.
 */
function localTitleForms(folderTitle: string): string[] {
  const title = bookTitleOnly(folderTitle)
  const segments = title.split(' - ')
  return segments.length > 1 ? [title, segments.slice(1).join(' - ')] : [title]
}

/** Best relation between any local title form and any of a result's title forms. */
function relateDoc(folderTitle: string, doc: OpenLibraryDoc): TitleRelation {
  let best: TitleRelation = 'none'
  for (const local of localTitleForms(folderTitle)) {
    for (const form of docTitleForms(doc)) {
      const r = relate(local, form)
      if (RELATION_RANK[r] < RELATION_RANK[best]) best = r
    }
  }
  return best
}

/** Does any folder author appear among the result's authors? */
function sharesAuthor(localAuthors: string[], doc: OpenLibraryDoc): boolean {
  const local = new Set(localAuthors.map(authorKey))
  return (doc.author_name ?? []).some(name => local.has(authorKey(name)))
}

interface Resolution {
  status: BookValidationStatus
  doc: OpenLibraryDoc | null
}

/**
 * Pick the most informative result. Author overlap first, then title
 * relation, then Open Library's own relevance order. The status follows from
 * the pick — `matched` needs both an exact title and a shared author.
 */
export function resolveBook(title: string, authors: string[], docs: OpenLibraryDoc[]): Resolution {
  const scored = docs
    .map((doc, index) => ({
      doc,
      index,
      relation: relateDoc(title, doc),
      author: sharesAuthor(authors, doc),
    }))
    .filter(s => s.relation !== 'none')
    .sort(
      (a, b) =>
        Number(b.author) - Number(a.author) ||
        RELATION_RANK[a.relation] - RELATION_RANK[b.relation] ||
        a.index - b.index
    )

  const best = scored[0]
  if (!best) return { status: 'not_found', doc: null }
  if (!best.author) return { status: 'author_mismatch', doc: best.doc }
  if (best.relation === 'exact') return { status: 'matched', doc: best.doc }
  return { status: best.relation === 'case' ? 'case' : 'close', doc: best.doc }
}

// ─────────────────────────────────────────────
// Search with fallbacks
// ─────────────────────────────────────────────

/** Cache key for one query. Lowercased so casing drift shares an entry. */
function queryKey(query: string, author: string | undefined): string {
  return `${query.toLowerCase()}|${(author ?? '').toLowerCase()}`
}

/**
 * Run the query chain, stopping at the first query with results:
 *   1. book title + first author
 *   2. book title alone (catches a misspelled author)
 *   3. first title segment + first author (catches a mangled subtitle)
 *
 * Results are cached per query. Empty results are NOT cached, so a book
 * Open Library didn't know about is asked again next run — same reasoning as
 * the TMDB pass re-asking its no-match verdicts.
 */
async function searchBook(
  book: BookOutput,
  client: OpenLibraryClient,
  cache: JsonCache<OpenLibraryDoc[]>
): Promise<{ docs: OpenLibraryDoc[]; cached: boolean }> {
  const title = bookTitleOnly(book.title)
  const query = title.replace(/\s+-\s+/g, ' ')
  const firstSegment = title.split(' - ')[0]!
  const author = book.authors[0]

  const chain: Array<[string, string | undefined]> = [[query, author]]
  chain.push([query, undefined])
  if (firstSegment !== title) chain.push([firstSegment, author])

  let allCached = true
  for (const [q, a] of chain) {
    const key = queryKey(q, a)
    let docs = cache.get(key)
    if (!docs) {
      allCached = false
      try {
        docs = await client.search(q, a)
      } catch (err) {
        console.error(`    [OPENLIBRARY] Search failed for '${q}': ${(err as Error).message}`)
        docs = []
      }
      if (docs.length > 0) cache.set(key, docs)
    }
    if (docs.length > 0) return { docs, cached: allCached }
  }
  return { docs: [], cached: false }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

/** `Title: Subtitle` for display. */
function displayTitle(doc: OpenLibraryDoc): string {
  return doc.subtitle ? `${doc.title}: ${doc.subtitle}` : doc.title
}

export async function validateAudiobooks(
  books: BookOutput[],
  rules: AudiobooksRules,
  client: OpenLibraryClient,
  cache: JsonCache<OpenLibraryDoc[]>,
  warnings: WarningCollector,
  onProgress?: (done: number, total: number, cached: number) => void
): Promise<BookValidation[]> {
  const out: BookValidation[] = []
  let cachedCount = 0

  for (let i = 0; i < books.length; i++) {
    const book = books[i]!
    const { docs, cached } = await searchBook(book, client, cache)
    if (cached) cachedCount++

    const { status, doc } = resolveBook(book.title, book.authors, docs)
    out.push({
      title: book.title,
      authors: book.authors,
      status,
      openlibrary_key: doc?.key ?? null,
      openlibrary_title: doc ? displayTitle(doc) : null,
      openlibrary_authors: doc?.author_name ?? [],
      first_publish_year: doc?.first_publish_year ?? null,
    })

    const authorFolder = book.authors.join(', ')
    const categories = categoriesOf(book.versions)
    const bookPath = [...categories.slice(0, 1), authorFolder, book.title].join('/')
    const options = { scope: { categories, levels: [authorFolder, book.title] } }
    const olTitle = doc ? displayTitle(doc) : ''
    const safeTitle = stripFilenameIllegalChars(olTitle.replace(/\s*:\s+/g, ' - '))
    const olAuthors = (doc?.author_name ?? []).join(', ')

    if (status === 'not_found' && rules.checks.warn_openlibrary_not_found) {
      warnings.add(
        'warn_openlibrary_not_found',
        bookPath,
        `Open Library found nothing matching '${bookTitleOnly(book.title)}' by ${authorFolder}. ` +
          `Check the title and author for typos — or ignore this if the book simply isn't in Open Library.`,
        options
      )
    } else if (status === 'close' && rules.checks.warn_openlibrary_title_mismatch) {
      warnings.add(
        'warn_openlibrary_title_mismatch',
        bookPath,
        `Possible typo: Open Library lists a book by ${olAuthors} titled '${olTitle}', ` +
          `close to but not the same as '${bookTitleOnly(book.title)}'. ` +
          `Verify the spelling; if Open Library is right, rename the folder using '${safeTitle}'.`,
        options
      )
    } else if (status === 'case' && rules.checks.warn_openlibrary_title_case) {
      warnings.add(
        'warn_openlibrary_title_case',
        bookPath,
        `Open Library capitalizes the title '${olTitle}'; the folder has '${bookTitleOnly(book.title)}'. ` +
          `Only the capitalization differs.`,
        options
      )
    } else if (status === 'author_mismatch' && rules.checks.warn_openlibrary_author_mismatch) {
      warnings.add(
        'warn_openlibrary_author_mismatch',
        bookPath,
        `Open Library's closest match for '${bookTitleOnly(book.title)}' is '${olTitle}' by ${olAuthors || 'an unknown author'}, ` +
          `which doesn't include ${authorFolder}. Check the author folder for a typo — or ignore this if it's a different book with the same title.`,
        options
      )
    }

    onProgress?.(i + 1, books.length, cachedCount)
  }

  return out
}
