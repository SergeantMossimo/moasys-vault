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
 * Comparison is case-insensitive: the local side is Windows/SMB, where case
 * never distinguishes two folders.
 */

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

/** Path segments, ignoring empty ones and a Windows drive letter's colon. */
function segments(p: string): string[] {
  return normalizePath(p)
    .split('/')
    .filter(s => s.length > 0)
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
  const types: MediaType[] = ['movies', 'shows', 'music', 'audiobooks']
  return types.flatMap(mediaType =>
    (config[mediaType] ?? []).map(root => ({
      mediaType,
      name: root.name,
      root_path: root.root_path,
    }))
  )
}

export class PathMapper {
  private readonly locations: LocationEntry[] = []
  private readonly pathMap: PathMapEntry[]
  /** Library locations that matched no root, for the run summary. */
  readonly unmappedLocations: Array<{ library: string; path: string }> = []
  /** Locations that matched more than one root, where the first was used. */
  readonly ambiguousLocations: Array<{ library: string; path: string; roots: string[] }> = []

  constructor(
    private readonly roots: RootRef[],
    sections: PlexSection[],
    pathMap: Array<{ plex: string; local: string }> = []
  ) {
    // Longest prefix first, so a specific entry beats a general one.
    this.pathMap = pathMap
      .map(e => ({ plexPrefix: normalizePath(e.plex), localPrefix: normalizePath(e.local) }))
      .sort((a, b) => b.plexPrefix.length - a.plexPrefix.length)

    for (const section of sections) {
      for (const location of section.Location ?? []) {
        this.addLocation(section.title, location.path)
      }
    }
    this.locations.sort((a, b) => b.plexPrefix.length - a.plexPrefix.length)
  }

  /**
   * Work out which root a library location corresponds to. `path_map` is
   * consulted first; otherwise the root whose final folder name occurs in
   * the location path (last occurrence wins, so `/Media/Movies/Movies` maps
   * the inner one).
   */
  private addLocation(library: string, plexPath: string): void {
    const viaMap = this.mapViaPathMap(plexPath)
    if (viaMap) {
      const root = this.roots.find(
        r => r.mediaType === viaMap.mediaType && r.name === viaMap.drive
      )!
      this.locations.push({
        plexPrefix: normalizePath(plexPath),
        root,
        relativePrefix: viaMap.relative,
      })
      return
    }

    const locationSegments = segments(plexPath)
    const candidates: Array<{ root: RootRef; index: number }> = []
    for (const root of this.roots) {
      const rootName = segments(root.root_path).at(-1)?.toLowerCase()
      if (!rootName) continue
      const index = locationSegments.map(s => s.toLowerCase()).lastIndexOf(rootName)
      if (index !== -1) candidates.push({ root, index })
    }

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
      relativePrefix: locationSegments.slice(index + 1).join('/'),
    })
  }

  /** Translate through `plex.path_map`, then find the root the local path falls under. */
  private mapViaPathMap(plexPath: string): MappedPath | null {
    for (const entry of this.pathMap) {
      const rest = stripPrefix(plexPath, entry.plexPrefix)
      if (rest === null) continue
      const local = joinRelative(entry.localPrefix, rest)
      // Most specific root first, so D:\Shows\Move beats D:\Shows.
      const roots = [...this.roots].sort((a, b) => b.root_path.length - a.root_path.length)
      for (const root of roots) {
        const relative = stripPrefix(local, root.root_path)
        if (relative !== null) return { mediaType: root.mediaType, drive: root.name, relative }
      }
      return null
    }
    return null
  }

  /** Map one Plex file path, or null when it falls outside every mapped location. */
  map(plexPath: string): MappedPath | null {
    const viaMap = this.mapViaPathMap(plexPath)
    if (viaMap) return viaMap
    for (const location of this.locations) {
      const rest = stripPrefix(plexPath, location.plexPrefix)
      if (rest === null) continue
      return {
        mediaType: location.root.mediaType,
        drive: location.root.name,
        relative: joinRelative(location.relativePrefix, rest),
      }
    }
    return null
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
