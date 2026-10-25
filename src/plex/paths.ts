/**
 * plex/paths.ts
 * -------------
 * Translate file paths as Plex reports them (the server's view, e.g.
 * `/volume1/Media/Movies/HD/Heat (1995)/Heat (1995).mkv` on a NAS) into the
 * scanner's view: a configured root plus a path relative to it
 * (`Server` + `HD/Heat (1995)/Heat (1995).mkv`).
 *
 * That translation is what lets Plex's catalog be compared with the scan
 * output and what puts Plex findings into the same warnings.json paths and
 * ignore lists as everything else.
 *
 * Two ways to map, tried in order:
 *
 *   1. `plex.path_map` in config.json — explicit prefix pairs. Always wins.
 *   2. Automatic — each library folder (Plex "Location") is matched to the
 *      configured root whose LAST folder name appears in the location path.
 *      `/volume1/Media/Movies` ↔ `M:\Movies`. A library pointed at a
 *      sub-folder works too: `/volume1/Media/Movies/HD` ↔ `M:\Movies` with
 *      every file landing under `HD/`.
 *
 * When a location could belong to roots of several media types — one share
 * holding Movies/ and Shows/ under a common root_path, say — the library's own
 * type (movie, show, artist) picks between them. Two roots of the SAME type
 * with the same folder name still need a `path_map` entry to tell apart.
 *
 * A root at the top of a drive (`D:\`) has no folder name to match on, so it
 * needs `path_map` too.
 *
 * Comparison is case-insensitive: the local side is Windows/SMB, where case
 * never distinguishes two folders.
 */

import { MEDIA_TYPES } from '../core/project'
import { MediaRootConfig } from '../core/types'

import { MediaType, PlexSection } from './types'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** A configured root, tagged with the media type it belongs to. */
export interface RootRef {
  mediaType: MediaType
  name: string
  root_path: string
}

/** Where a Plex path lives on this machine. */
export interface MappedPath {
  mediaType: MediaType
  /** Root name from config.json. */
  drive: string
  /** Path relative to the root, forward slashes, no leading slash. */
  relative: string
}

interface LocationEntry {
  /** Normalized Plex-side prefix. */
  plexPrefix: string
  root: RootRef
  /** Normalized path under the root that the location corresponds to ('' for the root itself). */
  relativePrefix: string
}

interface PathMapEntry {
  plexPrefix: string
  localPrefix: string
}

// ─────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────

/** Forward slashes, no duplicate or trailing slashes. Case is preserved. */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

/** Path segments, ignoring empty ones and a Windows drive letter (`D:`). */
function segments(p: string): string[] {
  return normalizePath(p)
    .split('/')
    .filter(s => s.length > 0 && !/^[A-Za-z]:$/.test(s))
}

/** The media types a Plex library of this type can hold. */
const SECTION_MEDIA_TYPES: Record<string, MediaType[]> = {
  movie: ['movies'],
  show: ['shows'],
  artist: ['music', 'audiobooks'],
}

/** Keep the items whose root suits the library type, unless that would leave none. */
function preferSectionType<T extends { root: RootRef }>(items: T[], sectionType?: string): T[] {
  const types = sectionType ? SECTION_MEDIA_TYPES[sectionType] : undefined
  if (!types) return items
  const suited = items.filter(item => types.includes(item.root.mediaType))
  return suited.length > 0 ? suited : items
}

/**
 * If `path` is `prefix` or inside it (case-insensitively), return the
 * remainder without a leading slash; otherwise null.
 */
export function stripPrefix(path: string, prefix: string): string | null {
  const p = normalizePath(path)
  const pre = normalizePath(prefix)
  const pl = p.toLowerCase()
  const prel = pre.toLowerCase()
  if (pl === prel) return ''
  const withSlash = prel.endsWith('/') ? prel : `${prel}/`
  return pl.startsWith(withSlash) ? p.slice(withSlash.length) : null
}

function joinRelative(a: string, b: string): string {
  return [a, b].filter(s => s.length > 0).join('/')
}

// ─────────────────────────────────────────────
// Mapper
// ─────────────────────────────────────────────

/** Flatten config.json's per-type root lists into tagged refs. */
export function rootRefs(config: Partial<Record<MediaType, MediaRootConfig[]>>): RootRef[] {
  return MEDIA_TYPES.flatMap(mediaType =>
    (config[mediaType] ?? []).map(root => ({
      mediaType,
      name: root.name,
      root_path: root.root_path,
    }))
  )
}

function toMapped(root: RootRef, relative: string): MappedPath {
  return { mediaType: root.mediaType, drive: root.name, relative }
}

export class PathMapper {
  private readonly locations: LocationEntry[] = []
  private readonly pathMap: PathMapEntry[]
  /** Most specific root first, so D:\Shows\Move beats D:\Shows. */
  private readonly rootsBySpecificity: RootRef[]
  /** Library locations that matched no root, for the run summary. */
  readonly unmappedLocations: Array<{ library: string; path: string }> = []
  /** Locations that matched more than one root, where the first was used. */
  readonly ambiguousLocations: Array<{ library: string; path: string; roots: string[] }> = []

  constructor(
    private readonly roots: RootRef[],
    sections: PlexSection[],
    pathMap: Array<{ plex: string; local: string }> = []
  ) {
    this.rootsBySpecificity = [...roots].sort((a, b) => b.root_path.length - a.root_path.length)
    // Longest prefix first, so a specific entry beats a general one.
    this.pathMap = pathMap
      .map(e => ({ plexPrefix: normalizePath(e.plex), localPrefix: normalizePath(e.local) }))
      .sort((a, b) => b.plexPrefix.length - a.plexPrefix.length)

    for (const section of sections) {
      for (const location of section.Location ?? []) {
        this.addLocation(section, location.path)
      }
    }
    this.locations.sort((a, b) => b.plexPrefix.length - a.plexPrefix.length)
  }

  /**
   * Work out which root a library location corresponds to. `path_map` is
   * consulted first; otherwise the root whose final folder name occurs in
   * the location path (last occurrence wins, so `/Media/Movies/Movies` maps
   * the inner one). Either way, roots that suit the library's type win.
   */
  private addLocation(section: PlexSection, plexPath: string): void {
    const library = section.title
    const viaMap = this.mapViaPathMap(plexPath, section.type)
    if (viaMap) {
      this.locations.push({ plexPrefix: normalizePath(plexPath), ...viaMap })
      return
    }

    const locationSegments = segments(plexPath).map(s => s.toLowerCase())
    const matches: Array<{ root: RootRef; index: number }> = []
    for (const root of this.roots) {
      const rootName = segments(root.root_path).at(-1)?.toLowerCase()
      if (!rootName) continue
      const index = locationSegments.lastIndexOf(rootName)
      if (index !== -1) matches.push({ root, index })
    }
    const candidates = preferSectionType(matches, section.type)

    if (candidates.length === 0) {
      this.unmappedLocations.push({ library, path: plexPath })
      return
    }
    if (candidates.length > 1) {
      this.ambiguousLocations.push({
        library,
        path: plexPath,
        roots: candidates.map(c => `${c.root.mediaType}:${c.root.name} (${c.root.root_path})`),
      })
    }

    const { root, index } = candidates[0]!
    this.locations.push({
      plexPrefix: normalizePath(plexPath),
      root,
      // Sliced from the original-case segments, so the relative path keeps its spelling.
      relativePrefix: segments(plexPath)
        .slice(index + 1)
        .join('/'),
    })
  }

  /**
   * Translate through `plex.path_map`, then find the root the local path
   * falls under — the most specific one, preferring roots that suit
   * `sectionType` when several share a path.
   */
  private mapViaPathMap(
    plexPath: string,
    sectionType?: string
  ): { root: RootRef; relativePrefix: string } | null {
    for (const entry of this.pathMap) {
      const rest = stripPrefix(plexPath, entry.plexPrefix)
      if (rest === null) continue
      const local = joinRelative(entry.localPrefix, rest)
      const containing = this.rootsBySpecificity
        .map(root => ({ root, relativePrefix: stripPrefix(local, root.root_path) }))
        .filter((m): m is { root: RootRef; relativePrefix: string } => m.relativePrefix !== null)
      return preferSectionType(containing, sectionType)[0] ?? null
    }
    return null
  }

  /**
   * Map one Plex file path, or null when it falls outside every mapped
   * location. Library locations are tried first — they already chose a root
   * by library type — and `path_map` covers files outside any of them.
   */
  map(plexPath: string): MappedPath | null {
    for (const location of this.locations) {
      const rest = stripPrefix(plexPath, location.plexPrefix)
      if (rest === null) continue
      return toMapped(location.root, joinRelative(location.relativePrefix, rest))
    }
    const viaMap = this.mapViaPathMap(plexPath)
    return viaMap ? toMapped(viaMap.root, viaMap.relativePrefix) : null
  }

  /** The media type a library's folders map to — the first location that maps decides. */
  sectionMediaType(section: PlexSection): MediaType | null {
    for (const location of section.Location ?? []) {
      const mapped = this.map(location.path)
      if (mapped) return mapped.mediaType
    }
    return null
  }
}
