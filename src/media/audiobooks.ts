/**
 * media/audiobooks.ts
 * -------------------
 * Audiobook-specific parsing, serialization, and DB logic for MOASYS-Vault.
 *
 * Expected folder structure (default rules):
 *   <media_folder>/
 *     <Author Name>/                          ← single author
 *     <Author 1, Author 2>/                   ← multiple authors, comma-separated
 *     <Author 1, Author 2, and Author 3>/     ← multiple authors with "and"
 *       <Book Title>/
 *         01 - Chapter Name.m4b
 *         101 - Chapter Name.mp3   ← multi-disc (Book On CD)
 *
 * Chapter patterns come from src/core/rules/audiobooks.ts (with optional
 * YAML overrides in rules/audiobooks.yaml).
 *
 * Author folder parsing lives in code below — see parseAuthors().
 */

import fs from 'fs'
import path from 'path'

import {
  AudiobooksConfig,
  BookRecord,
  BookOutput,
  WarningCollector,
  MediaModule,
} from '../core/types'
import { hasExtension, isPrimary, formatPrimaryExts, findUnexpectedEntries } from '../core/files'
import { findNumericGaps } from '../core/gaps'
import { AudiobooksRules } from '../core/rules/audiobooks'
import { compilePattern, resolveCategories } from '../core/rules/helpers'
import { finalizeVersions, distinctCategories } from '../core/versions'
import { ProbeData } from '../probe/types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Parse an author folder name into a list of individual author names.
 * Handles three formats:
 *   "J.R.R. Tolkien"                    -> ["J.R.R. Tolkien"]
 *   "Terry Pratchett, Neil Gaiman"       -> ["Terry Pratchett", "Neil Gaiman"]
 *   "Author 1, Author 2, and Author 3"  -> ["Author 1", "Author 2", "Author 3"]
 *
 * Strategy: strip " and " before the last author, then split on commas.
 */
function parseAuthors(folderName: string): string[] {
  const cleaned = folderName.replace(/,?\s+and\s+/gi, ', ')
  return cleaned
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0)
}

/**
 * Parse a chapter file stem into { disc, chapter, name } or null.
 * Tries the multi-disc pattern first (more specific), then single-disc as fallback.
 * Single-disc files (e.g. "01 - Chapter Name") are treated as disc 1.
 */
function parseChapterStem(
  stem: string,
  multiDiscRegex: RegExp,
  singleDiscRegex: RegExp
): { disc: number; chapter: number; name: string } | null {
  const mm = multiDiscRegex.exec(stem)
  if (mm?.groups) {
    const { disc, chapter, name } = mm.groups
    if (disc !== undefined && chapter !== undefined && name !== undefined) {
      return { disc: parseInt(disc, 10), chapter: parseInt(chapter, 10), name: name.trim() }
    }
  }
  const sm = singleDiscRegex.exec(stem)
  if (sm?.groups) {
    const { chapter, name } = sm.groups
    if (chapter !== undefined && name !== undefined) {
      return { disc: 1, chapter: parseInt(chapter, 10), name: name.trim() }
    }
  }
  return null
}

function makeBookKey(title: string): string {
  return title.toLowerCase()
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export function createAudiobooksModule(
  rules: AudiobooksRules
): MediaModule<BookRecord, BookOutput, AudiobooksConfig> {
  const multiDiscRegex = compilePattern(rules.patterns.multi_disc)
  const singleDiscRegex = compilePattern(rules.patterns.single_disc)

  const effectiveCategories = resolveCategories(rules.categories)
  const categoryOrder = effectiveCategories.map(c => c.name)

  return {
    getCategories: () => effectiveCategories,

    scanCategory(
      folderPath: string,
      folderName: string,
      category: string,
      config: AudiobooksConfig,
      warnings: WarningCollector,
      _probeByPath: Map<string, ProbeData>
    ): Map<string, BookRecord> {
      const records = new Map<string, BookRecord>()

      const rootEntries = fs.readdirSync(folderPath, { withFileTypes: true })

      // Loose audio files at media folder level — silently dropped without
      // this check. Expected structure: Author/Book/chapters.
      if (rules.checks.warn_loose_files) {
        const looseRoot = rootEntries.filter(
          e => e.isFile() && hasExtension(e.name, rules.audio_extensions)
        )
        if (looseRoot.length > 0) {
          warnings.add(
            'warn_loose_files',
            folderName,
            `${looseRoot.length} loose audio file(s) in media folder root — expected an Author/Book/chapters structure. ` +
              `Move chapters into Author/Book/ subfolders.`
          )
        }
      }

      // Non-media, non-sidecar files at media folder root.
      if (rules.checks.warn_unexpected_entries) {
        const unexpected = findUnexpectedEntries(
          rootEntries,
          rules.audio_extensions,
          rules.sidecar_extensions
        )
        if (unexpected.length > 0) {
          const names = unexpected.map(e => `'${e.name}'`).join(', ')
          warnings.add(
            'warn_unexpected_entries',
            folderName,
            `Unexpected file(s) in media folder root: ${names}. Expected only Author/ subfolders plus sidecars.`
          )
        }
      }

      for (const authorEntry of rootEntries) {
        if (!authorEntry.isDirectory()) continue

        const authorPath = path.join(folderPath, authorEntry.name)
        const authorRel = path.join(folderName, authorEntry.name)
        const authors = parseAuthors(authorEntry.name)

        let bookEntries: fs.Dirent[]
        try {
          bookEntries = fs.readdirSync(authorPath, { withFileTypes: true })
        } catch {
          warnings.add('permission_denied', authorRel, 'Permission denied reading author folder')
          continue
        }

        // Loose audio files in author folder (no Book subfolder around them)
        // — silently dropped from the catalog without this check.
        if (rules.checks.warn_loose_files) {
          const looseAuthor = bookEntries.filter(
            e => e.isFile() && hasExtension(e.name, rules.audio_extensions)
          )
          if (looseAuthor.length > 0) {
            warnings.add(
              'warn_loose_files',
              authorRel,
              `${looseAuthor.length} loose audio file(s) in author folder — expected a Book subfolder around chapters. ` +
                `Create a book subfolder and move chapters into it.`
            )
          }
        }

        // Non-media, non-sidecar files in author folder (author image, NFO).
        if (rules.checks.warn_unexpected_entries) {
          const unexpected = findUnexpectedEntries(
            bookEntries,
            rules.audio_extensions,
            rules.sidecar_extensions
          )
          if (unexpected.length > 0) {
            const names = unexpected.map(e => `'${e.name}'`).join(', ')
            warnings.add(
              'warn_unexpected_entries',
              authorRel,
              `Unexpected file(s) in author folder: ${names}. Expected only Book/ subfolders plus sidecars.`
            )
          }
        }

        for (const bookEntry of bookEntries) {
          if (!bookEntry.isDirectory()) continue

          const bookPath = path.join(authorPath, bookEntry.name)
          const bookRel = path.join(authorRel, bookEntry.name)
          const bookKey = makeBookKey(bookEntry.name)

          let allFiles: fs.Dirent[]
          try {
            allFiles = fs.readdirSync(bookPath, { withFileTypes: true })
          } catch {
            warnings.add('permission_denied', bookRel, 'Permission denied reading book folder')
            continue
          }

          // Subfolders inside a book are silently ignored — chapters in
          // them would be dropped. Multi-disc books should use disc-prefixed
          // chapter numbers (101, 201) in a flat layout.
          if (rules.checks.warn_extra_subfolders) {
            const subfolders = allFiles.filter(e => e.isDirectory())
            if (subfolders.length > 0) {
              const names = subfolders.map(s => `'${s.name}'`).join(', ')
              warnings.add(
                'warn_extra_subfolders',
                bookRel,
                `Unexpected subfolder(s) in book folder: ${names}. ` +
                  `Expected a flat chapter layout — for multi-disc books, use disc-prefixed numbers ` +
                  `(e.g. '101 - Chapter.mp3' for disc 1, '201 - Chapter.mp3' for disc 2). ` +
                  `Files inside these subfolders are not scanned.`
              )
            }
          }

          // Non-media, non-sidecar files in book folder.
          if (rules.checks.warn_unexpected_entries) {
            const unexpected = findUnexpectedEntries(
              allFiles,
              rules.audio_extensions,
              rules.sidecar_extensions
            )
            if (unexpected.length > 0) {
              const names = unexpected.map(e => `'${e.name}'`).join(', ')
              warnings.add(
                'warn_unexpected_entries',
                bookRel,
                `Unexpected file(s) in book folder: ${names}. Expected only chapter files plus sidecars.`
              )
            }
          }

          const audioFiles = allFiles.filter(
            f => f.isFile() && hasExtension(f.name, rules.audio_extensions)
          )
          const nonPrimary = audioFiles.filter(f => !isPrimary(f.name, rules.primary_extension))

          if (audioFiles.length === 0) {
            if (rules.checks.warn_no_audio) {
              warnings.add(
                'warn_no_audio',
                bookRel,
                'No recognized audio files found in book folder'
              )
            }
            continue
          }

          if (rules.checks.warn_non_primary) {
            for (const f of nonPrimary) {
              const ext = path.extname(f.name).toLowerCase()
              warnings.add(
                'warn_non_primary',
                path.join(bookRel, f.name),
                `${formatPrimaryExts(rules.primary_extension)} audio file — may need re-encoding`,
                { extension: ext }
              )
            }
          }

          // Chapter numbers per disc for gap detection: { discNum: [chapterNums] }
          const discChapters = new Map<number, number[]>()
          let chapterCount = 0

          for (const f of audioFiles) {
            const stem = path.basename(f.name, path.extname(f.name))
            const parsed = parseChapterStem(stem, multiDiscRegex, singleDiscRegex)

            if (!parsed) {
              if (rules.checks.warn_bad_chapter_name) {
                warnings.add(
                  'warn_bad_chapter_name',
                  path.join(bookRel, f.name),
                  'Chapter file name does not match naming convention — ' +
                    'expected: 01 - Chapter Name.ext or 101 - Chapter Name.ext (multi-disc)'
                )
              }
              continue
            }

            const { disc, chapter } = parsed
            chapterCount++

            if (!discChapters.has(disc)) discChapters.set(disc, [])
            discChapters.get(disc)!.push(chapter)
          }

          if (rules.checks.warn_chapter_gaps) {
            for (const [discNum, chapters] of [...discChapters.entries()].sort(
              ([a], [b]) => a - b
            )) {
              const gaps = findNumericGaps(chapters)
              if (gaps.length > 0) {
                const gapStr = gaps.map(g => `Chapter ${String(g).padStart(2, '0')}`).join(', ')
                const discStr = discChapters.size > 1 ? `Disc ${discNum}` : 'Book'
                warnings.add(
                  'warn_chapter_gaps',
                  bookRel,
                  `Potential missing chapters in ${discStr}: ${gapStr}`
                )
              }
            }
          }

          if (!records.has(bookKey)) {
            records.set(bookKey, {
              title: bookEntry.name,
              authors,
              chapter_count: chapterCount,
              versions: [],
            })
          } else {
            records.get(bookKey)!.chapter_count = Math.max(
              records.get(bookKey)!.chapter_count,
              chapterCount
            )
          }

          // Codecs from audio file extensions — one Version per (category,
          // codec) pair. Books with mixed formats (rare but possible: an
          // Audible m4b + a Book On CD mp3 set) end up with multiple
          // entries. Deduped on serialize.
          const codecs = new Set<string>()
          for (const f of audioFiles) {
            codecs.add(path.extname(f.name).slice(1).toUpperCase())
          }
          const book = records.get(bookKey)!
          for (const codec of codecs) {
            book.versions.push({ category, quality: codec })
          }
        }
      }

      return records
    },

    merge(existing: Map<string, BookRecord>, incoming: Map<string, BookRecord>): void {
      for (const [bookKey, newBook] of incoming) {
        if (!existing.has(bookKey)) {
          existing.set(bookKey, newBook)
        } else {
          const existingBook = existing.get(bookKey)!
          existingBook.versions.push(...newBook.versions)
          existingBook.chapter_count = Math.max(existingBook.chapter_count, newBook.chapter_count)
        }
      }
    },

    serialize(records: Map<string, BookRecord>): BookOutput[] {
      return [...records.values()]
        .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()))
        .map(book => ({
          title: book.title,
          authors: book.authors,
          chapter_count: book.chapter_count,
          versions: finalizeVersions(book.versions, categoryOrder),
        }))
    },

    /**
     * Post-merge check: emit one warning per book that ended up in multiple
     * categories. Runs once after all folders are scanned.
     */
    postScan(records: Map<string, BookRecord>, warnings: WarningCollector): void {
      if (!rules.checks.warn_duplicate_book) return

      for (const book of records.values()) {
        const cats = distinctCategories(book.versions)
        if (cats.length <= 1) continue
        const catSet = new Set(cats)
        if (isAcceptableComboSet(catSet, rules.acceptable_book_combos)) continue
        const ordered = categoryOrder.filter(c => cats.includes(c))
        // Path uses Author/Book Title for parity with music's Artist/Album
        // duplicate-album path. authors[] is comma-separated for multi-author
        // books to mirror the on-disk folder convention.
        warnings.add(
          'warn_duplicate_book',
          path.join(book.authors.join(', '), book.title),
          `Duplicate book found in multiple categories: ${ordered.join(', ')}`,
          // The path carries no category — this check spans them by
          // definition — so scope derivation would read the author as one.
          // Spelling it out is also what lets a `folders:` entry reach here.
          { scope: { categories: ordered, levels: [book.authors.join(', '), book.title] } }
        )
      }
    },
  }
}

/** Return true if `set` matches one of the acceptable category combos. */
function isAcceptableComboSet(set: Set<string>, combos: readonly string[][]): boolean {
  return combos.some(combo => combo.length === set.size && combo.every(c => set.has(c)))
}
