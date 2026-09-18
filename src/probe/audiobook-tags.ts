/**
 * probe/audiobook-tags.ts
 * -----------------------
 * Compare an audiobook's embedded tags (album, album artist) against its
 * book and author folder names.
 *
 * Music's folder/tag comparison is an exact match, which is right for albums
 * but wrong for audiobooks. Audible-style tags follow their own conventions,
 * so a naive comparison would flag nearly every book:
 *
 *   Folder: A Clash of Kings - A Song of Ice and Fire, Book 2
 *   Album:  A Clash of Kings (Unabridged)
 *
 *   Folder: Andrzej Sapkowski, Danusia Stok
 *   Artist: Andrzej Sapkowski, Danusia Stok - translator
 *
 * So both sides are normalized first — edition markers and role suffixes
 * dropped, `: ` read as the ` - ` a folder name has to use, curly quotes
 * folded, full-width stand-ins for illegal characters mapped back — and a
 * folder that ADDS a ` - subtitle` to the tag's title still matches. What
 * survives is a real disagreement:
 *
 *   Folder: Halo - Saint's Testimony       Album: Saint's Testimony: HALO
 *   Folder: Cassandra Rose Clarke          Artist: Cassandra Rose Clark
 *
 * Pure functions only. The probe pass gathers tags and emits the warnings.
 */

import { toComparableFolderName } from '../core/files'
import { authorKey, foldQuotes } from '../media/audiobook-names'

import { TagData } from './types'

// ─────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────

/**
 * Full-width and modifier-letter look-alikes people use in folder names in
 * place of characters Windows forbids. Mapped back to the real character so
 * `Electric Sheep？` compares equal to a tag's `Electric Sheep?`.
 */
const LOOKALIKES: Record<string, string> = {
  '？': '?',
  '：': ':',
  '꞉': ':',
  '／': '/',
  '＼': '\\',
  '＊': '*',
  '＂': '"',
  '＜': '<',
  '＞': '>',
  '｜': '|',
}

/** Edition markers Audible appends to album tags: `(Unabridged)`, `[Abridged]`. */
const EDITION_MARKER = /\s*[([](?:un)?abridged(?: edition)?[)\]]\s*$/i

/** Role suffixes on an artist tag: `Danusia Stok - translator`. */
const ROLE_SUFFIX =
  /\s+-\s+(?:translator|contributor|editor|narrator|foreword|introduction|afterword)s?$/i

/**
 * Normalize a title — from a tag or a folder — into the form a folder name
 * could hold, keeping case so capitalization drift stays detectable.
 */
export function comparableTitle(s: string): string {
  const mapped = [...s].map(ch => LOOKALIKES[ch] ?? ch).join('')
  const withSeparators = foldQuotes(mapped.replace(EDITION_MARKER, ''))
    // A subtitle colon can't exist on disk; folders use ` - ` instead.
    .replace(/\s*:\s+/g, ' - ')
  return toComparableFolderName(withSeparators).replace(/\s+/g, ' ').trim()
}

/** Split an artist tag or author folder into individual, role-free names. */
export function splitAuthors(s: string): string[] {
  return s
    .replace(/,?\s+(?:and|&)\s+/gi, ', ')
    .split(/\s*[,;/]\s*/)
    .map(name => name.replace(ROLE_SUFFIX, '').trim())
    .filter(name => name.length > 0)
}

// ─────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────

export type TagComparison = 'match' | 'case-only' | 'mismatch'

/**
 * Compare an album tag with a book folder name. A folder may extend the tag
 * with extra ` - ` segments (subtitle, series), and a tag may extend the
 * folder the same way — either is a match, since neither is wrong.
 */
export function compareBookTitle(tag: string, folder: string): TagComparison {
  const t = comparableTitle(tag)
  const f = comparableTitle(folder)
  const extends_ = (a: string, b: string) => a === b || a.startsWith(`${b} - `)

  if (extends_(f, t) || extends_(t, f)) return 'match'
  const tl = t.toLowerCase()
  const fl = f.toLowerCase()
  if (extends_(fl, tl) || extends_(tl, fl)) return 'case-only'
  return 'mismatch'
}

/**
 * Compare an artist tag with the folder's author list, ignoring order and
 * role suffixes. Case-only when the names agree once lowercased; anything
 * else — including spacing between initials — is a mismatch, because Plex
 * matches artist names exactly.
 */
export function compareAuthors(tag: string, folderAuthors: string[]): TagComparison {
  const sortedSet = (names: string[], fold: (s: string) => string) =>
    [...new Set(names.map(fold))].sort().join('|')

  const tagNames = splitAuthors(tag)
  const exact = (s: string) => foldQuotes(s).replace(/\s+/g, ' ')
  if (sortedSet(tagNames, exact) === sortedSet(folderAuthors, exact)) return 'match'
  const lower = (s: string) => exact(s).toLowerCase()
  if (sortedSet(tagNames, lower) === sortedSet(folderAuthors, lower)) return 'case-only'
  return 'mismatch'
}

// ─────────────────────────────────────────────
// Per-book analysis
// ─────────────────────────────────────────────

export interface BookTags {
  title: string
  authorFolder: string
  authors: string[]
  /** One entry per probed chapter; null when the file had no readable tags. */
  tags: Array<TagData | null>
}

export type BookTagCheck =
  | 'warn_book_tag_mismatch'
  | 'warn_book_tag_case'
  | 'warn_author_tag_mismatch'
  | 'warn_author_tag_case'
  | 'warn_missing_book_tags'

export interface BookTagFinding {
  type: BookTagCheck
  issue: string
  /**
   * The remedy for this check, relayed to `WarningOptions.fix` so it is
   * written once per bucket instead of on every row. Constant per `type`.
   */
  fix: string
}

/**
 * The remedy for each tag check. Kept in one map so every `findings.push` of
 * a given type relays the same text — `WarningCollector.groupedByType()` takes
 * the first it sees and warns if a bucket disagrees with itself.
 */
const FIX: Record<BookTagCheck, string> = {
  warn_missing_book_tags:
    `Plex reads the album and artist tags to name and group a book in a music-type ` +
    `library. Tag the chapters with the book title and author.`,
  warn_book_tag_mismatch:
    `Correct whichever is wrong — rename the folder, or retag the chapters. Plex names ` +
    `the book from the tag, so a mismatch shows a different title than your folder.`,
  warn_book_tag_case: `Make them agree so Plex shows the same title as your folder.`,
  warn_author_tag_mismatch:
    `Correct whichever is wrong. Plex matches artist names exactly, so the book can end ` +
    `up filed under a separate author.`,
  warn_author_tag_case: `Make them agree so Plex files the book under the same author.`,
}

/** The most common non-empty value, and how many chapters carry it. */
function dominant(
  values: Array<string | null | undefined>
): { value: string; count: number } | null {
  const counts = new Map<string, number>()
  for (const v of values) {
    const trimmed = v?.trim()
    if (trimmed) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
  let best: { value: string; count: number } | null = null
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count }
  }
  return best
}

/** Is `a` just a differently spaced/initialed form of the same names as `b`? */
function sameAuthorsLoosely(tagNames: string[], folderAuthors: string[]): boolean {
  const keys = (names: string[]) => [...new Set(names.map(authorKey))].sort().join('|')
  return keys(tagNames) === keys(folderAuthors)
}

/**
 * Check one book's tags against its folders. At most one finding per check.
 * The comparison uses the value most chapters carry, so a single mis-tagged
 * chapter doesn't produce a warning for the whole book.
 */
export function analyzeBookTags(
  book: BookTags,
  enabled: Record<BookTagCheck, boolean>
): BookTagFinding[] {
  const findings: BookTagFinding[] = []
  const present = book.tags.filter((t): t is TagData => t !== null)
  const album = dominant(present.map(t => t.album))
  const artist = dominant(present.map(t => t.album_artist ?? t.artist))

  if (!album && !artist) {
    if (enabled.warn_missing_book_tags && book.tags.length > 0) {
      findings.push({
        type: 'warn_missing_book_tags',
        issue:
          `None of the ${book.tags.length} chapter files carry an album or artist tag. ` +
          `Expected album '${book.title}', artist '${book.authorFolder}'.`,
        fix: FIX.warn_missing_book_tags,
      })
    }
    return findings
  }

  if (album) {
    const comparison = compareBookTitle(album.value, book.title)
    const chapters = `${album.count} of ${book.tags.length} chapter(s)`
    if (comparison === 'mismatch' && enabled.warn_book_tag_mismatch) {
      findings.push({
        type: 'warn_book_tag_mismatch',
        issue: `Folder says '${book.title}', album tag on ${chapters} says '${album.value}'.`,
        fix: FIX.warn_book_tag_mismatch,
      })
    } else if (comparison === 'case-only' && enabled.warn_book_tag_case) {
      findings.push({
        type: 'warn_book_tag_case',
        issue:
          `Capitalization only: folder '${book.title}' vs album tag on ${chapters} ` +
          `'${album.value}'.`,
        fix: FIX.warn_book_tag_case,
      })
    }
  }

  if (artist) {
    const comparison = compareAuthors(artist.value, book.authors)
    const chapters = `${artist.count} of ${book.tags.length} chapter(s)`
    if (comparison === 'mismatch' && enabled.warn_author_tag_mismatch) {
      const spacingOnly = sameAuthorsLoosely(splitAuthors(artist.value), book.authors)
      findings.push({
        type: 'warn_author_tag_mismatch',
        issue:
          `Folder says '${book.authorFolder}', artist tag on ${chapters} says '${artist.value}'` +
          (spacingOnly ? ' — same name, different initials or spacing' : '') +
          `.`,
        fix: FIX.warn_author_tag_mismatch,
      })
    } else if (comparison === 'case-only' && enabled.warn_author_tag_case) {
      findings.push({
        type: 'warn_author_tag_case',
        issue:
          `Capitalization only: folder '${book.authorFolder}' vs artist tag on ${chapters} ` +
          `'${artist.value}'.`,
        fix: FIX.warn_author_tag_case,
      })
    }
  }

  return findings
}
