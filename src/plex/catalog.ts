/**
 * plex/catalog.ts
 * ---------------
 * Pure transforms from raw Plex metadata into the output shapes written by
 * `npm run plex:pull`. No I/O — the runner fetches, these shape.
 */

import { PathMapper } from './paths'
import {
  PlexCatalogItem,
  PlexCollection,
  PlexFileRef,
  PlexItemType,
  PlexMetadata,
  PlexSection,
} from './types'

// ─────────────────────────────────────────────
// Library slugs
// ─────────────────────────────────────────────

/**
 * Folder-safe form of a library title: lowercase, anything outside
 * `[a-z0-9._-]` collapsed to a single dash, trimmed of dashes. `TV Shows` →
 * `tv-shows`, `Kids' Movies (4K)` → `kids-movies-4k`.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // combining accents left by NFKD: é → e
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug.length > 0 ? slug : 'library'
}

/**
 * Assign every library a unique folder name. Computed over ALL libraries in
 * server order, so pulling a subset never changes a library's folder. Two
 * libraries whose titles slug the same get the section key appended.
 */
export function assignSlugs(sections: PlexSection[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const s of sections) counts.set(slugify(s.title), (counts.get(slugify(s.title)) ?? 0) + 1)

  const slugs = new Map<string, string>()
  for (const s of sections) {
    const base = slugify(s.title)
    slugs.set(s.key, counts.get(base)! > 1 ? `${base}-${s.key}` : base)
  }
  return slugs
}

// ─────────────────────────────────────────────
// Item types
// ─────────────────────────────────────────────

/**
 * Which item types to pull from a library. Seasons are skipped — they carry
 * no files and their title/number is already on every episode.
 * Photo libraries aren't part of the scanner's world and return nothing.
 */
export function itemTypesFor(sectionType: string): PlexItemType[] {
  switch (sectionType) {
    case 'movie':
      return ['movie']
    case 'show':
      return ['show', 'episode']
    case 'artist':
      return ['artist', 'album', 'track']
    default:
      return []
  }
}

/** Item types that Plex's duplicate filter applies to — the ones that own files. */
export const DUPLICATE_FILTER_TYPES: PlexItemType[] = ['movie', 'episode', 'track']

// ─────────────────────────────────────────────
// Transforms
// ─────────────────────────────────────────────

/** Every file behind an item, mapped to this machine where possible. */
function fileRefs(meta: PlexMetadata, mapper: PathMapper): PlexFileRef[] {
  const refs: PlexFileRef[] = []
  for (const media of meta.Media ?? []) {
    for (const part of media.Part ?? []) {
      if (!part.file) continue
      const mapped = mapper.map(part.file)
      refs.push({
        plex_path: part.file,
        drive: mapped?.drive ?? null,
        library_path: mapped?.relative ?? null,
        deleted: part.deletedAt !== undefined || media.deletedAt !== undefined,
      })
    }
  }
  return refs
}

/** Shape one raw Plex item for catalog.json. */
export function toCatalogItem(
  meta: PlexMetadata,
  type: PlexItemType,
  mapper: PathMapper,
  duplicateKeys: ReadonlySet<string>
): PlexCatalogItem {
  return {
    rating_key: meta.ratingKey,
    type,
    title: meta.title,
    original_title: meta.originalTitle ?? null,
    year: meta.year ?? null,
    guid: meta.guid ?? null,
    edition_title: meta.editionTitle ?? null,
    external_ids: (meta.Guid ?? []).map(g => g.id),
    grandparent_rating_key: meta.grandparentRatingKey ?? null,
    parent_rating_key: meta.parentRatingKey ?? null,
    grandparent_title: meta.grandparentTitle ?? null,
    parent_title: meta.parentTitle ?? null,
    index: meta.index ?? null,
    parent_index: meta.parentIndex ?? null,
    duplicate: duplicateKeys.has(meta.ratingKey),
    files: fileRefs(meta, mapper),
  }
}

/** Shape one collection and its children for collections.json. */
export function toCollection(meta: PlexMetadata, children: PlexMetadata[]): PlexCollection {
  return {
    rating_key: meta.ratingKey,
    title: meta.title,
    subtype: meta.subtype ?? null,
    smart: meta.smart === true || meta.smart === '1',
    item_count: children.length,
    items: children.map(c => ({
      rating_key: c.ratingKey,
      type: c.type,
      title: c.title,
      year: c.year ?? null,
    })),
  }
}

/**
 * Agents that never match anything. Items in a library using one of these
 * all carry `local://` guids by design, so "unmatched" means nothing there.
 */
const NON_MATCHING_AGENTS = new Set(['com.plexapp.agents.none', 'tv.plex.agents.none'])

/** Is this library's agent one that matches items to online metadata? */
export function agentMatches(agent: string | null | undefined): boolean {
  return !!agent && !NON_MATCHING_AGENTS.has(agent)
}

/** Did Plex fail to match this item to its agent? */
export function isUnmatched(item: Pick<PlexCatalogItem, 'guid'>): boolean {
  return (
    !item.guid ||
    item.guid.startsWith('local://') ||
    item.guid.startsWith('com.plexapp.agents.none://')
  )
}
