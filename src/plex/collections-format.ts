/**
 * plex/collections-format.ts
 * --------------------------
 * The collection-review.md format `npm run collections` reads. Pure — no I/O.
 *
 *   # Create            ← collections that don't exist yet
 *   ## Toy Story        ← one collection
 *   - Toy Story (1995)  ← one item; every item line is acted on
 *
 *   # Add               ← collections that already exist
 *   # Remove            ← take items out of existing collections
 *
 * Top-level section names match case-insensitively, and `#Remove` (no
 * space) works too. Any other top-level heading starts a section that's
 * ignored, as is every line that isn't a heading or a `- ` item.
 */

export type CollectionAction = 'create' | 'add' | 'remove'

/** One item line: `- Title (Year)` or, for albums, `- Album — Artist (Year)`. */
export interface ItemLine {
  /** 0-based line number in the file, for rewriting it after an apply. */
  lineNo: number
  /** The line's text after `- `, as written. */
  text: string
  /** Text before the artist separator and the trailing year. */
  title: string
  /** Album artist, when the line has an ` — Artist` part. */
  artist: string | null
  /** The trailing `(YYYY)`, when there is one. */
  year: number | null
}

export interface CollectionBlock {
  action: CollectionAction
  /** The collection name, exactly as written after `## `. */
  name: string
  /** 0-based line number of the `## ` heading. */
  lineNo: number
  items: ItemLine[]
}

export interface ParsedReview {
  blocks: CollectionBlock[]
  /** Item lines outside any action section or collection heading. */
  stray: ItemLine[]
}

const SECTION_RE = /^#(?!#)\s*(.+?)\s*$/
const COLLECTION_RE = /^##(?!#)\s*(.+?)\s*$/
const ITEM_RE = /^\s*[-*]\s+(.+?)\s*$/
const YEAR_RE = /^(.*?)\s*\((\d{4})\)$/
/** An em or en dash between spaces separates album from artist. */
const ARTIST_SEP_RE = /\s[—–]\s/

/** Split an item's text into title, artist and year. */
export function parseItemText(text: string, lineNo = 0): ItemLine {
  let rest = text
  let year: number | null = null
  const y = YEAR_RE.exec(rest)
  if (y) {
    rest = y[1]!
    year = Number(y[2])
  }
  let artist: string | null = null
  const parts = rest.split(ARTIST_SEP_RE)
  if (parts.length > 1) {
    artist = parts.pop()!.trim()
    rest = parts.join(' — ')
  }
  return { lineNo, text, title: rest.trim(), artist, year }
}

function sectionAction(name: string): CollectionAction | null {
  const n = name.toLowerCase()
  return n === 'create' || n === 'add' || n === 'remove' ? n : null
}

export function parseReview(markdown: string): ParsedReview {
  const blocks: CollectionBlock[] = []
  const stray: ItemLine[] = []
  let action: CollectionAction | null = null
  let block: CollectionBlock | null = null

  markdown.split(/\r?\n/).forEach((line, lineNo) => {
    const collection = COLLECTION_RE.exec(line)
    if (collection) {
      block = action ? { action, name: collection[1]!, lineNo, items: [] } : null
      if (block) blocks.push(block)
      return
    }
    const section = SECTION_RE.exec(line)
    if (section) {
      action = sectionAction(section[1]!)
      block = null
      return
    }
    const item = ITEM_RE.exec(line)
    if (!item) return
    const parsed = parseItemText(item[1]!, lineNo)
    if (block) block.items.push(parsed)
    else if (action) stray.push(parsed)
  })

  return { blocks, stray }
}

/**
 * The file with the given item lines removed, then any collection heading
 * left with no items and any action section left with no collections.
 */
export function removeLines(markdown: string, lineNos: ReadonlySet<number>): string {
  const lines = markdown.split(/\r?\n/)
  const kept = lines.filter((_, i) => !lineNos.has(i))

  // Drop `## ` headings with no items before the next heading.
  const hasItemsAfter = (from: number) => {
    for (let j = from + 1; j < kept.length; j++) {
      if (SECTION_RE.test(kept[j]!) || COLLECTION_RE.test(kept[j]!)) return false
      if (ITEM_RE.test(kept[j]!)) return true
    }
    return false
  }
  const noEmptyCollections = kept.filter((l, i) => !COLLECTION_RE.test(l) || hasItemsAfter(i))

  // Drop action sections with no collections left.
  const hasCollectionAfter = (arr: string[], from: number) => {
    for (let j = from + 1; j < arr.length; j++) {
      if (SECTION_RE.test(arr[j]!)) return false
      if (COLLECTION_RE.test(arr[j]!)) return true
    }
    return false
  }
  const out = noEmptyCollections.filter((l, i) => {
    const s = SECTION_RE.exec(l)
    return !s || !sectionAction(s[1]!) || hasCollectionAfter(noEmptyCollections, i)
  })

  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}
