/**
 * plex/types.ts
 * -------------
 * Shared types for the Plex integration.
 *
 * Two groupings:
 *   1. Raw Plex Media Server JSON shapes — only the fields we read. Plex
 *      returns far more; everything here is optional unless Plex always
 *      sends it, because fields vary by server version and item type.
 *   2. Output shapes written to output/plex/<library>/ and read back by the
 *      check pass.
 */

/** The four config.json media types. */
export type MediaType = 'movies' | 'shows' | 'music' | 'audiobooks'

// ─────────────────────────────────────────────
// Raw Plex shapes
// ─────────────────────────────────────────────

/** Every Plex response wraps its payload in a MediaContainer. */
export interface PlexResponse<T> {
  MediaContainer: T
}

export interface PlexIdentity {
  machineIdentifier: string
  version: string
}

/** One library folder from `/library/sections`. */
export interface PlexLocation {
  id: number
  path: string
}

/** One library ("section") from `/library/sections`. */
export interface PlexSection {
  key: string
  /** `movie`, `show`, `artist`, or `photo`. */
  type: string
  title: string
  agent?: string
  scanner?: string
  Location?: PlexLocation[]
}

export interface PlexSectionsContainer {
  Directory?: PlexSection[]
}

/** One file of one version of an item. */
export interface PlexPart {
  id: number
  file?: string
  size?: number
  /** Set when Plex has noticed the file is gone and put the item in the trash. */
  deletedAt?: number
}

/** One version of an item. A movie with two files in two folders has two. */
export interface PlexMedia {
  id: number
  deletedAt?: number
  Part?: PlexPart[]
}

/** Movies, shows, seasons, episodes, artists, albums, tracks, collections. */
export interface PlexMetadata {
  ratingKey: string
  type: string
  title: string
  originalTitle?: string
  year?: number
  /** Agent identifier, e.g. `plex://movie/5d77…`, or `local://123` when unmatched. */
  guid?: string
  /** External ids, e.g. `imdb://tt0118826`. Only present with `includeGuids=1`. */
  Guid?: Array<{ id: string }>
  /** Show key on an episode; artist key on a track or album. */
  grandparentRatingKey?: string
  /** Season key on an episode; album key on a track. */
  parentRatingKey?: string
  /** Show title on an episode; artist on a track. */
  grandparentTitle?: string
  /** Season title on an episode; album on a track. */
  parentTitle?: string
  /** Episode number / track number. */
  index?: number
  /** Season number / disc number. */
  parentIndex?: number
  /** Collections: movie/show/artist/album. */
  subtype?: string
  /** Collections: '1' when the collection is smart (rule-based). */
  smart?: string | boolean
  childCount?: number | string
  leafCount?: number
  deletedAt?: number
  Media?: PlexMedia[]
}

export interface PlexMetadataContainer {
  size: number
  totalSize?: number
  offset?: number
  Metadata?: PlexMetadata[]
}

/** The metadata `type` numbers Plex's `type=` query parameter expects. */
export const PLEX_TYPE_NUMBER = {
  movie: 1,
  show: 2,
  season: 3,
  episode: 4,
  artist: 8,
  album: 9,
  track: 10,
} as const

export type PlexItemType = keyof typeof PLEX_TYPE_NUMBER

// ─────────────────────────────────────────────
// Output shapes
// ─────────────────────────────────────────────

/** A file as Plex reports it, plus where it lives on this machine when that could be worked out. */
export interface PlexFileRef {
  /** Path exactly as Plex reports it (the server's view). */
  plex_path: string
  /** Root name from config.json this file maps to, or null. */
  drive: string | null
  /** Path relative to that root, forward slashes, or null when unmapped. */
  library_path: string | null
  /** True when Plex has flagged this file deleted (it's in the library trash). */
  deleted: boolean
}

/** One item in a library's catalog.json. */
export interface PlexCatalogItem {
  rating_key: string
  type: PlexItemType
  title: string
  original_title: string | null
  year: number | null
  guid: string | null
  /** External ids (`imdb://…`, `tmdb://…`, `tvdb://…`). */
  external_ids: string[]
  /** Episode: the show's rating_key. Track: the artist's. */
  grandparent_rating_key: string | null
  /** Episode: the season's rating_key. Track: the album's. Album: the artist's. */
  parent_rating_key: string | null
  /** Episode: show title. Track: artist. */
  grandparent_title: string | null
  /** Episode: season title. Track: album. Album: artist. */
  parent_title: string | null
  /** Episode or track number. */
  index: number | null
  /** Season or disc number. */
  parent_index: number | null
  /** Plex lists this item under its "Duplicates" filter. */
  duplicate: boolean
  /** Files behind this item, one per version part. Empty for shows, artists, albums. */
  files: PlexFileRef[]
}

/** One Plex library in libraries.json. */
export interface PlexLibrarySummary {
  key: string
  title: string
  /** Plex section type: movie, show, artist, photo. */
  plex_type: string
  /** Folder name under output/plex/. */
  slug: string
  agent: string | null
  locations: string[]
  /**
   * Each library folder as a drive + library-relative path (`''` when the
   * folder is the root itself). Unmapped folders are omitted. Lets the check
   * tell "Plex never scanned this file" from "this folder isn't in the library".
   */
  mapped_locations: Array<{ plex_path: string; drive: string; library_path: string }>
  /**
   * The config.json media type this library's folders map to, or null when
   * none of its locations map to a configured root.
   */
  media_type: MediaType | null
  item_count: number
  collection_count: number
}

/** output/plex/libraries.json */
export interface PlexLibrariesOutput {
  generated: string
  server: { machine_identifier: string; version: string }
  libraries: PlexLibrarySummary[]
}

/** output/plex/<library>/catalog.json */
export interface PlexCatalogOutput {
  generated: string
  library: PlexLibrarySummary
  items: PlexCatalogItem[]
}

/** One collection in collections.json. */
export interface PlexCollection {
  rating_key: string
  title: string
  /** What the collection holds: movie, show, artist, album. */
  subtype: string | null
  smart: boolean
  item_count: number
  items: Array<{ rating_key: string; type: string; title: string; year: number | null }>
}

/** output/plex/<library>/collections.json */
export interface PlexCollectionsOutput {
  generated: string
  library: { key: string; title: string; slug: string }
  collections: PlexCollection[]
}
