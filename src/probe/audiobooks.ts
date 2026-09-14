/**
 * probe/audiobooks.ts
 * -------------------
 * ffprobe pass for audiobooks — walks the library and records per-chapter
 * probe data. No quality logic (spoken word at modest bitrates is fine).
 */

import fs from 'fs'
import path from 'path'

import { AudiobooksConfig, WarningCollector } from '../core/types'
import { isPrimary } from '../core/files'
import { AudiobooksRules } from '../core/rules/audiobooks'
import { compilePattern, resolveCategories } from '../core/rules/helpers'

import { analyzeBookTags } from './audiobook-tags'
import { ProbeCache } from './cache'
import { ProbeTask, ProbedFile, probeBatch } from './helpers'
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

function parseAuthors(folderName: string): string[] {
  const cleaned = folderName.replace(/,?\s+and\s+/gi, ', ')
  return cleaned
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0)
}

function parseChapterStem(
  stem: string,
  multiDiscRegex: RegExp,
  singleDiscRegex: RegExp
): { disc: number; chapter: number } | null {
  const mm = multiDiscRegex.exec(stem)
  if (mm?.groups) {
    const { disc, chapter } = mm.groups
    if (disc !== undefined && chapter !== undefined) {
      return { disc: parseInt(disc, 10), chapter: parseInt(chapter, 10) }
    }
  }
  const sm = singleDiscRegex.exec(stem)
  if (sm?.groups) {
    const { chapter } = sm.groups
    if (chapter !== undefined) return { disc: 1, chapter: parseInt(chapter, 10) }
  }
  return null
}

function bookKey(t: string): string {
  return t.toLowerCase()
}

function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

function collectTasks(
  config: AudiobooksConfig,
  rules: AudiobooksRules
): Array<{ task: ProbeTask; identity: ChapterIdentity }> {
  const multiDiscRegex = compilePattern(rules.patterns.multi_disc)
  const singleDiscRegex = compilePattern(rules.patterns.single_disc)
  const out: Array<{ task: ProbeTask; identity: ChapterIdentity }> = []

  for (const cat of resolveCategories(rules.categories)) {
    const folderPath = path.join(config.root_path, cat.folderName)
    // Missing folders are reported once, by the scan pass (core/scanner.ts).
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue

    for (const authorEntry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!authorEntry.isDirectory()) continue
      const authorPath = path.join(folderPath, authorEntry.name)
      const authors = parseAuthors(authorEntry.name)

      let bookEntries: fs.Dirent[]
      try {
        bookEntries = fs.readdirSync(authorPath, { withFileTypes: true })
      } catch {
        continue
      }

      for (const bookEntry of bookEntries) {
        if (!bookEntry.isDirectory()) continue
        const bookPath = path.join(authorPath, bookEntry.name)

        let files: fs.Dirent[]
        try {
          files = fs.readdirSync(bookPath, { withFileTypes: true })
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

    const key = bookKey(id.title)
    let book = books.get(key)
    if (!book) {
      book = { title: id.title, authors: id.authors, media_type: [], chapters: [] }
      books.set(key, book)
    }
    if (!book.media_type.includes(id.mediaType)) book.media_type.push(id.mediaType)

    const chapter: ChapterProbe = {
      quality: task.category,
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
    const categories = book.media_type.filter(c => c !== 'default')
    const bookPath = categories[0]
      ? path.join(categories[0], identity.authorFolder, book.title)
      : path.join(identity.authorFolder, book.title)
    for (const finding of findings) {
      warnings.add(finding.type, bookPath, finding.issue, {
        scope: { categories, levels: [identity.authorFolder, book.title] },
      })
    }
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

export async function probeAudiobooks(
  config: AudiobooksConfig,
  rules: AudiobooksRules,
  cache: ProbeCache,
  warnings: WarningCollector
): Promise<ProbeResult<BookProbeOutput[]>> {
  const collected = collectTasks(config, rules)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  const identities = new Map<string, ChapterIdentity>()
  for (const { task, identity } of collected) identities.set(task.relativePath, identity)

  const tasks = collected.map(c => c.task)
  const probed = await probeBatch(
    tasks,
    cache,
    (done, total, cached) => {
      if (done === total || done % 50 === 0) {
        console.log(`    [PROBE] ${done}/${total} (${cached} cached)`)
      }
    },
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
