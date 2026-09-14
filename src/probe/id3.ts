/**
 * probe/id3.ts
 * ------------
 * Thin wrapper around the `music-metadata` package for reading ID3 (MP3),
 * Vorbis comment (FLAC/OGG), MP4 (M4A) and WMA tags from audio files.
 *
 * Invoked by the music and audiobooks probe passes — movies and shows don't
 * read tags (they don't carry meaningful metadata for our purposes).
 *
 * The package normalizes tag names across container formats so we get a
 * consistent `common.*` shape regardless of how the source file is encoded.
 * We further trim that down to a stable TagData shape with only the fields
 * we use, so probe.json doesn't bloat with rarely-useful tag fields.
 */

import { parseFile } from 'music-metadata'

import { TagData } from './types'

/**
 * Read embedded metadata tags from an audio file.
 *
 * Returns null when music-metadata can't parse the file (corrupt header,
 * unsupported container, etc.) — the caller treats null the same as "no
 * tags found", which from a warnings perspective means `missing_tags` may
 * fire if enabled.
 *
 * music-metadata accepts options like `duration: false` to skip the
 * (slow) duration calculation, but we never need it from this path since
 * ffprobe already provides it. Default options keep the call fast.
 */
export async function readTags(filePath: string): Promise<TagData | null> {
  try {
    const md = await parseFile(filePath, { duration: false })
    const c = md.common

    return {
      title: c.title ?? null,
      artist: c.artist ?? null,
      album_artist: c.albumartist ?? null,
      album: c.album ?? null,
      year: c.year ?? null,
      track: c.track?.no ?? null,
      total_tracks: c.track?.of ?? null,
      disc: c.disk?.no ?? null,
      total_discs: c.disk?.of ?? null,
      // music-metadata returns genre as string[] | undefined. We standardize
      // to string[] | null so consumers never see undefined.
      genre: c.genre ?? null,
    }
  } catch {
    return null
  }
}
