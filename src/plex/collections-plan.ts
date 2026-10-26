/**
 * plex/collections-plan.ts
 * ------------------------
 * Turn a parsed collection-review.md into the exact collection changes to
 * make, against the library's live state. Pure — no I/O.
 *
 * Everything is validated before anything is planned: one bad line, a
 * Create for a name that already exists (or nearly does), or an Add/Remove
 * for a collection that doesn't, and the plan carries `problems` and no
 * operations. The runner refuses to touch Plex unless `problems` is empty.
 */

import { CollectionBlock, ItemLine, ParsedReview } from './collections-format'

/** One library item, as much of it as matching needs. */
export interface LibraryItem {
  ratingKey: string
  title: string
  year: number | null
  /** Album artist; null for movies and shows. */
  artist: string | null
  /** TMDB id from the item's external ids, when it has one. */
  tmdbId: string | null
  /** TMDB's title for that id, from the validation cache, when known. */
  tmdbTitle: string | null
}

/** One existing collection in the library. */
export interface LiveCollection {
  ratingKey: string
  title: string
  smart: boolean
  /** Rating keys of its items; only needed for collections the file names. */
  itemKeys: Set<string>
}

/**
 * One request's worth of change. `group` ties together the requests for one
 * collection under one action (a long Add is several batches); its `lines`
 * are done only once every request in the group has succeeded. A create's
 * follow-up batches have an empty `collectionKey` until the create returns it.
 */
export interface Operation {
  kind: 'create' | 'add' | 'remove'
  collection: string
  collectionKey: string
  ratingKeys: string[]
  group: string
  lines: ItemLine[]
}

export interface Skipped {
  collection: string
  line: ItemLine
  reason: string
}

export interface Plan {
  problems: string[]
  operations: Operation[]
  skipped: Skipped[]
}

/** Most item keys one add request carries, to keep URLs a sensible length. */
export const ADD_BATCH_SIZE = 50

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

/** Collection names that differ only in case, punctuation or a leading "The". */
export const foldName = (s: string) =>
  norm(s)
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '')

/** A title with any trailing "(YYYY)" of its own removed. */
const stripYear = (s: string) => s.replace(/\s*\(\d{4}\)\s*$/, '')

/** Items that are the same title: one TMDB id, or one rating key. */
const identity = (i: LibraryItem) => (i.tmdbId ? `tmdb:${i.tmdbId}` : `key:${i.ratingKey}`)

/**
 * Every library item a line names: all copies of exactly one title. Throws
 * a message when it names none, or more than one different title.
 */
export function resolveLine(line: ItemLine, items: LibraryItem[]): LibraryItem[] {
  const full = norm(line.text)
  const title = norm(line.title)
  const artistOk = (i: LibraryItem) =>
    !line.artist || (i.artist !== null && norm(i.artist) === norm(line.artist))
  const titleOk = (i: LibraryItem) =>
    [i.title, stripYear(i.title), i.tmdbTitle]
      .filter((t): t is string => !!t)
      .some(t => norm(t) === title || norm(t) === full)

  const named = items.filter(i => artistOk(i) && titleOk(i))
  let pool = named
  if (line.year !== null) {
    const exact = named.filter(i => i.year === line.year || norm(i.title) === full)
    pool = exact.length
      ? exact
      : named.filter(i => i.year !== null && Math.abs(i.year - line.year!) <= 1)
  }
  if (pool.length === 0) throw new Error(`no match in this library for "${line.text}"`)

  const ids = new Set(pool.map(identity))
  if (ids.size > 1) {
    const which = pool.map(
      i => `${i.title}${i.year ? ` (${i.year})` : ''}${i.artist ? ` — ${i.artist}` : ''}`
    )
    throw new Error(
      `"${line.text}" matches more than one title: ${[...new Set(which)].join('; ')}. Add the year or artist.`
    )
  }
  // Every copy of that one title, wherever the pool found it.
  const id = [...ids][0]!
  return items.filter(i => identity(i) === id)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function planChanges(
  review: ParsedReview,
  items: LibraryItem[],
  collections: LiveCollection[]
): Plan {
  const problems: string[] = []
  const operations: Operation[] = []
  const skipped: Skipped[] = []
  const byName = new Map(collections.map(c => [c.title, c]))
  const byFold = new Map(collections.map(c => [foldName(c.title), c]))

  for (const line of review.stray) {
    problems.push(`line ${line.lineNo + 1}: "${line.text}" isn't under a "## Collection" heading`)
  }

  // A collection may appear once per action.
  const seen = new Set<string>()
  for (const b of review.blocks) {
    const key = `${b.action}|${b.name}`
    if (seen.has(key))
      problems.push(`"${b.name}" appears twice under # ${title(b.action)} — merge them`)
    seen.add(key)
  }
  const created = new Set(review.blocks.filter(b => b.action === 'create').map(b => b.name))
  for (const b of review.blocks) {
    if (b.action !== 'create' && created.has(b.name)) {
      problems.push(
        `"${b.name}" is under # Create and # ${title(b.action)} — put new collections only under # Create`
      )
    }
  }

  // Resolve every line first, so all problems are reported together.
  const resolved = new Map<ItemLine, LibraryItem[]>()
  for (const b of review.blocks) {
    if (b.items.length === 0) problems.push(`"${b.name}" under # ${title(b.action)} has no items`)
    for (const line of b.items) {
      try {
        resolved.set(line, resolveLine(line, items))
      } catch (err) {
        problems.push(`line ${line.lineNo + 1} (${b.name}): ${(err as Error).message}`)
      }
    }
  }

  // The same title both added to and removed from one collection is a contradiction.
  const keysOf = (b: CollectionBlock) =>
    new Set(b.items.flatMap(l => (resolved.get(l) ?? []).map(identity)))
  for (const add of review.blocks.filter(b => b.action === 'add')) {
    const rem = review.blocks.find(b => b.action === 'remove' && b.name === add.name)
    if (!rem) continue
    const both = [...keysOf(add)].filter(k => keysOf(rem).has(k))
    if (both.length)
      problems.push(`"${add.name}": the same title is listed under both # Add and # Remove`)
  }

  for (const b of review.blocks) {
    const live = byName.get(b.name)
    if (b.action === 'create') {
      if (live) problems.push(`"${b.name}" already exists — move it under # Add`)
      else if (byFold.has(foldName(b.name)))
        problems.push(
          `"${b.name}" is almost the same as the existing "${byFold.get(foldName(b.name))!.title}" — use that exact name under # Add, or rename one of them`
        )
      continue
    }
    if (!live) {
      const near = byFold.get(foldName(b.name))
      problems.push(
        near
          ? `"${b.name}" doesn't exist — did you mean "${near.title}"?`
          : `"${b.name}" doesn't exist — move it under # Create to make it`
      )
    } else if (live.smart) {
      problems.push(
        `"${b.name}" is a smart collection — Plex fills it from rules, so it can't be edited here`
      )
    }
  }

  if (problems.length) return { problems, operations: [], skipped: [] }

  for (const b of review.blocks) {
    const live = byName.get(b.name)
    if (b.action === 'create') {
      const keys = [...new Set(b.items.flatMap(l => resolved.get(l)!.map(i => i.ratingKey)))]
      // The first batch creates the collection; the rest are adds to it.
      const [first, ...rest] = chunk(keys, ADD_BATCH_SIZE)
      const group = `create|${b.name}`
      operations.push({
        kind: 'create',
        collection: b.name,
        collectionKey: '',
        ratingKeys: first!,
        group,
        lines: b.items,
      })
      for (const batch of rest) {
        operations.push({
          kind: 'add',
          collection: b.name,
          collectionKey: '',
          ratingKeys: batch,
          group,
          lines: b.items,
        })
      }
      continue
    }
    const keys: string[] = []
    const lines: ItemLine[] = []
    for (const line of b.items) {
      const copies = resolved.get(line)!
      const inIt = copies.filter(i => live!.itemKeys.has(i.ratingKey))
      if (b.action === 'add') {
        const missing = copies.filter(i => !live!.itemKeys.has(i.ratingKey))
        if (inIt.length && !missing.length)
          skipped.push({ collection: b.name, line, reason: 'already in it' })
        else {
          keys.push(...missing.map(i => i.ratingKey))
          lines.push(line)
        }
      } else if (!inIt.length) skipped.push({ collection: b.name, line, reason: 'not in it' })
      else {
        keys.push(...inIt.map(i => i.ratingKey))
        lines.push(line)
      }
    }
    const unique = [...new Set(keys)]
    if (!unique.length) continue
    const group = `${b.action}|${b.name}`
    if (b.action === 'add') {
      for (const batch of chunk(unique, ADD_BATCH_SIZE)) {
        operations.push({
          kind: 'add',
          collection: b.name,
          collectionKey: live!.ratingKey,
          ratingKeys: batch,
          group,
          lines,
        })
      }
    } else {
      // Plex removes one item per request.
      for (const k of unique) {
        operations.push({
          kind: 'remove',
          collection: b.name,
          collectionKey: live!.ratingKey,
          ratingKeys: [k],
          group,
          lines,
        })
      }
    }
  }

  return { problems, operations, skipped }
}

function title(action: string): string {
  return action[0]!.toUpperCase() + action.slice(1)
}
