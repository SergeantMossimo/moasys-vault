/**
 * probe/audiobooks.ts
 * -------------------
 * ffprobe pass for audiobooks — walks the library and records per-chapter
 * probe data. No quality logic (spoken word at modest bitrates is fine).
 */

import fs from 'fs'
import path from 'path'

import { DirReader } from '../core/dir-reader'
import { AudiobooksConfig, WarningCollector } from '../core/types'
import { isPrimary, toRel } from '../core/files'
import { AudiobooksRules } from '../core/rules/audiobooks'
import {
  categoryPath,
  compilePattern,
  isRealCategory,
  resolveCategories,
} from '../core/rules/helpers'

import { bookKey, parseChapterStem } from '../media/audiobooks'

import { analyzeBookTags, splitAuthors } from './audiobook-tags'
import { ProbeCache } from './cache'
import { ProbeTask, ProbedFile, logProbeProgress, probeBatch } from './helpers'
import { readTags } from './id3'
import { BookProbeOutput, ChapterProbe, ProbeData, ProbeResult } from './types'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

interface ChapterIdentity {
  title: string
  authorFolder: string
  authors: string[]
  mediaType: string
  disc: number
  chapter: number
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

function collectTasks(
  config: AudiobooksConfig,
  rules: AudiobooksRules,
  dir: DirReader
): Array<{ task: ProbeTask; identity: ChapterIdentity }> {
  const multiDiscRegex = compilePattern(rules.patterns.multi_disc)
  const singleDiscRegex = compilePattern(rules.patterns.single_disc)
  const out: Array<{ task: ProbeTask; identity: ChapterIdentity }> = []

  for (const cat of resolveCategories(rules.categories)) {
    const folderPath = path.join(config.root_path, cat.folderName)
    // Missing folders are reported once, by the scan pass (core/scanner.ts).
    if (!dir.isDirectory(folderPath)) continue

    let topEntries: fs.Dirent[]
    try {
      topEntries = dir.readdir(folderPath)
    } catch {
      continue // the scan pass reports it as permission_denied
    }

    for (const authorEntry of topEntries) {
      if (!authorEntry.isDirectory()) continue
      const authorPath = path.join(folderPath, authorEntry.name)
      const authors = splitAuthors(authorEntry.name)

      let bookEntries: fs.Dirent[]
      try {
        bookEntries = dir.readdir(authorPath)
      } catch {
        continue
      }

      for (const bookEntry of bookEntries) {
        if (!bookEntry.isDirectory()) continue
        const bookPath = path.join(authorPath, bookEntry.name)

        let files: fs.Dirent[]
        try {
          files = dir.readdir(bookPath)
        } catch {
          continue
        }

        for (const f of files) {
          if (!f.isFile()) continue
          if (!isPrimary(f.name, rules.primary_extension)) continue

          const stem = path.basename(f.name, path.extname(f.name))
          const parsed = parseChapterStem(stem, multiDiscRegex, singleDiscRegex)
          if (!parsed) continue

          const absolutePath = path.join(bookPath, f.name)
          let stat: fs.Stats
          try {
            stat = fs.statSync(absolutePath)
          } catch {
            continue
          }

          out.push({
            task: {
              relativePath: toRel(
                path.join(cat.folderName, authorEntry.name, bookEntry.name, f.name)
              ),
              absolutePath,
              category: cat.name,
              quality: cat.quality,
              mtime: stat.mtimeMs,
              size: stat.size,
            },
            identity: {
              title: bookEntry.name,
              authorFolder: authorEntry.name,
              authors,
              mediaType: cat.name,
              disc: parsed.disc,
              chapter: parsed.chapter,
            },
          })
        }
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────

function aggregate(
  probed: ProbedFile[],
  identities: Map<string, ChapterIdentity>,
  mediaTypeOrder: string[]
): BookProbeOutput[] {
  const books = new Map<string, BookProbeOutput>()

  for (const { task, data } of probed) {
    const id = identities.get(task.relativePath)
    if (!id) continue

    const key = bookKey(id.authorFolder, id.title)
    let book = books.get(key)
    if (!book) {
      book = { title: id.title, authors: id.authors, media_type: [], chapters: [] }
      books.set(key, book)
    }
    if (!book.media_type.includes(id.mediaType)) book.media_type.push(id.mediaType)

    const chapter: ChapterProbe = {
      category: task.category,
      path: task.relativePath,
      disc: id.disc,
      chapter: id.chapter,
      size_bytes: data.size_bytes,
      duration_seconds: data.duration_seconds,
      bitrate: data.bitrate,
      video: data.video,
      audio: data.audio,
      tags: data.tags,
    }
    book.chapters.push(chapter)
  }

  const mtIndex = (m: string) => {
    const i = mediaTypeOrder.indexOf(m)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  for (const book of books.values()) {
    book.media_type.sort((a, b) => mtIndex(a) - mtIndex(b))
    book.chapters.sort((a, b) => (a.disc !== b.disc ? a.disc - b.disc : a.chapter - b.chapter))
  }

  return [...books.values()].sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  )
}

// ─────────────────────────────────────────────
// Tag checks
// ─────────────────────────────────────────────

/**
 * Compare each book's embedded album/artist tags with its folders. See
 * probe/audiobook-tags.ts for the normalization that keeps Audible-style
 * tags (`Title (Unabridged)`, `Name - translator`) from firing on every book.
 */
function checkBookTags(
  books: BookProbeOutput[],
  identities: Map<string, ChapterIdentity>,
  rules: AudiobooksRules,
  warnings: WarningCollector
): void {
  for (const book of books) {
    const first = book.chapters[0]
    const identity = first ? identities.get(first.path) : undefined
    if (!identity) continue

    const findings = analyzeBookTags(
      {
        title: book.title,
        authorFolder: identity.authorFolder,
        authors: book.authors,
        tags: book.chapters.map(c => c.tags),
      },
      rules.checks
    )
    // The path can show one category, but the scope carries all of them so a
    // `folders:` entry matches regardless of which came first.
    const categories = book.media_type.filter(isRealCategory)
    const bookPath = categoryPath(categories[0], identity.authorFolder, book.title)
    for (const finding of findings) {
      warnings.add(finding.type, bookPath, finding.issue, {
        fix: finding.fix,
        scope: { categories, levels: [identity.authorFolder, book.title] },
      })
    }
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

/**
 * Run the audiobooks probe pass end-to-end: walk the library, probe each
 * chapter (cache-aware, with its embedded tags), aggregate per book, and emit
 * the tag-vs-folder warnings. Cache writes are the caller's responsibility.
 */
export async function probeAudiobooks(
  config: AudiobooksConfig,
  rules: AudiobooksRules,
  cache: ProbeCache,
  warnings: WarningCollector,
  dir: DirReader = new DirReader()
): Promise<ProbeResult<BookProbeOutput[]>> {
  const collected = collectTasks(config, rules, dir)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  const identities = new Map<string, ChapterIdentity>()
  for (const { task, identity } of collected) identities.set(task.relativePath, identity)

  const tasks = collected.map(c => c.task)
  const probed = await probeBatch(
    tasks,
    cache,
    logProbeProgress,
    readTags,
    warnings,
    config.probe_concurrency
  )

  const mediaTypeOrder = resolveCategories(rules.categories).map(c => c.name)
  const byPath = new Map<string, ProbeData>()
  for (const { task, data } of probed) byPath.set(task.relativePath, data)

  const output = aggregate(probed, identities, mediaTypeOrder)
  checkBookTags(output, identities, rules, warnings)

  return { output, byPath }
}
