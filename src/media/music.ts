/**
 * media/music.ts
 * --------------
 * Music-specific parsing, serialization, and DB logic for MOASYS-Vault.
 *
 * Expected folder structure (default rules):
 *   <media_folder>/
 *     <Artist Name>/
 *       <Album Name>/
 *         01 - Track Name.flac
 *         101 - Track Name.flac     ← multi-disc: disc 1, track 1
 *         201 - Track Name.flac     ← multi-disc: disc 2, track 1
 *
 * Track patterns come from src/core/rules/music.ts (with optional YAML
 * overrides in rules/music.yaml).
 */

import fs from 'fs'
import path from 'path'

import {
  MusicConfig,
  ArtistRecord,
  ArtistOutput,
  WarningCollector,
  MediaModule,
} from '../core/types'
import {
  hasExtension,
  isPrimary,
  formatPrimaryExts,
  findSuspiciousPathChars,
  findUnexpectedEntries,
} from '../core/files'
import { findNumericGaps, formatGaps } from '../core/gaps'
import { MusicRules } from '../core/rules/music'
import { compilePattern, resolveCategories } from '../core/rules/helpers'
import { finalizeVersions, distinctCategories } from '../core/versions'
import { ProbeData } from '../probe/types'

/**
 * The remedy for each warning type, written once per bucket in warnings.json
 * rather than repeated on every row — see `WarningOptions.fix`.
 *
 * They live in one map because several types fire from more than one call site
 * (`warn_loose_files` at both the category root and an artist folder, for
 * instance) and a `fix` must read the same whichever site produced the row.
 * Keep each one generic enough to cover every site that uses it, and keep
 * per-row detail in the `issue` instead.
 */
const FIX = {
  warn_loose_files:
    `Plex expects 'Artist/Album/01 - Track.ext'. Move the tracks into an album folder under ` +
    `an artist — use 'Various Artists' for multi-artist compilations. Loose files are not ` +
    `in the catalog.`,
  warn_unexpected_entries:
    `Expected only subfolders or track files, plus sidecars (cover art, NFO, lyrics). ` +
    `Move or delete anything else.`,
  warn_extra_subfolders:
    `Plex uses a flat track layout. For multi-disc albums use disc-prefixed numbers ` +
    `('101 - Track.flac', '201 - Track.flac') instead of per-disc folders — files in these ` +
    `subfolders are not scanned.`,
  warn_bad_artist_folder: `Rename to match patterns.artist_folder in rules/music.yaml.`,
  warn_bad_album_folder: `Rename to match patterns.album_folder in rules/music.yaml.`,
  warn_suspicious_folder_chars:
    `Rename the folder without these characters — they break on other filesystems and can ` +
    `stop Plex matching the folder at all.`,
  warn_no_audio: `Add the tracks, or delete the empty folder.`,
  warn_non_primary: `Re-encode to your primary format if you want one format throughout.`,
  warn_bad_track_name: `Rename to '01 - Track Name.ext', or '101 - Track Name.ext' for multi-disc albums.`,
  warn_track_gaps: `Add the missing tracks, or ignore this if the album really skips them.`,
  warn_duplicate_album:
    `The same album in two categories — keep the copy in the category you want and delete ` +
    `the rest.`,
  permission_denied: `Check the folder's permissions, or whether the drive is still mounted.`,
} as const

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Parse a track file stem into { disc, track, name } or null.
 * Tries the multi-disc pattern first (more specific), then single-disc as fallback.
 * Single-disc files (e.g. "01 - Track Name") are treated as disc 1.
 */
function parseTrackStem(
  stem: string,
  multiDiscRegex: RegExp,
  singleDiscRegex: RegExp
): { disc: number; track: number; name: string } | null {
  const mm = multiDiscRegex.exec(stem)
  if (mm?.groups) {
    const { disc, track, name } = mm.groups
    if (disc !== undefined && track !== undefined && name !== undefined) {
      return { disc: parseInt(disc, 10), track: parseInt(track, 10), name: name.trim() }
    }
  }
  const sm = singleDiscRegex.exec(stem)
  if (sm?.groups) {
    const { track, name } = sm.groups
    if (track !== undefined && name !== undefined) {
      return { disc: 1, track: parseInt(track, 10), name: name.trim() }
    }
  }
  return null
}

function makeArtistKey(artist: string): string {
  return artist.toLowerCase()
}

function makeAlbumKey(artist: string, album: string): string {
  return `${artist.toLowerCase()}|${album.toLowerCase()}`
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export function createMusicModule(
  rules: MusicRules
): MediaModule<ArtistRecord, ArtistOutput, MusicConfig> {
  const artistFolderRegex = compilePattern(rules.patterns.artist_folder)
  const albumFolderRegex = compilePattern(rules.patterns.album_folder)
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
      config: MusicConfig,
      warnings: WarningCollector,
      _probeByPath: Map<string, ProbeData>
    ): Map<string, ArtistRecord> {
      const records = new Map<string, ArtistRecord>()

      const rootEntries = fs.readdirSync(folderPath, { withFileTypes: true })

      // Loose audio files at media folder level — silently dropped without
      // this check. Plex expects every track to live inside Artist/Album/.
      if (rules.checks.warn_loose_files) {
        const looseRoot = rootEntries.filter(
          e => e.isFile() && hasExtension(e.name, rules.audio_extensions)
        )
        if (looseRoot.length > 0) {
          warnings.add(
            'warn_loose_files',
            folderName,
            `${looseRoot.length} loose audio file(s) in the category root.`,
            { fix: FIX.warn_loose_files }
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
            `Unexpected file(s) in the category root: ${names}.`,
            { fix: FIX.warn_unexpected_entries }
          )
        }
      }

      for (const artistEntry of rootEntries) {
        if (!artistEntry.isDirectory()) continue

        const artistPath = path.join(folderPath, artistEntry.name)
        const artistRel = path.join(folderName, artistEntry.name)
        const artistKey = makeArtistKey(artistEntry.name)

        // Artist folder validation — warnings only, do not skip the folder.
        // Plex would still index a weirdly-named folder; users want to know.
        if (rules.checks.warn_bad_artist_folder && !artistFolderRegex.test(artistEntry.name)) {
          warnings.add(
            'warn_bad_artist_folder',
            artistRel,
            `Folder name does not match patterns.artist_folder.`,
            { fix: FIX.warn_bad_artist_folder }
          )
        }
        if (rules.checks.warn_suspicious_folder_chars) {
          const issues = findSuspiciousPathChars(artistEntry.name)
          if (issues.length > 0) {
            warnings.add(
              'warn_suspicious_folder_chars',
              artistRel,
              `Suspicious characters in artist folder: ${issues.join(', ')}.`,
              { fix: FIX.warn_suspicious_folder_chars }
            )
          }
        }

        let albumEntries: fs.Dirent[]
        try {
          albumEntries = fs.readdirSync(artistPath, { withFileTypes: true })
        } catch {
          warnings.add('permission_denied', artistRel, 'Permission denied reading artist folder.', {
            fix: FIX.permission_denied,
          })
          continue
        }

        // Loose audio files at artist level — silently dropped without this
        // check. The user's typical case: soundtracks organized as
        // Category/AlbumName/tracks (no artist level around the album).
        if (rules.checks.warn_loose_files) {
          const looseArtist = albumEntries.filter(
            e => e.isFile() && hasExtension(e.name, rules.audio_extensions)
          )
          if (looseArtist.length > 0) {
            warnings.add(
              'warn_loose_files',
              artistRel,
              `${looseArtist.length} loose audio file(s) in the artist folder, outside any album.`,
              { fix: FIX.warn_loose_files }
            )
          }
        }

        // Non-media, non-sidecar files in artist folder (artist.jpg etc. are
        // sidecars and allowed; random other files are not).
        if (rules.checks.warn_unexpected_entries) {
          const unexpected = findUnexpectedEntries(
            albumEntries,
            rules.audio_extensions,
            rules.sidecar_extensions
          )
          if (unexpected.length > 0) {
            const names = unexpected.map(e => `'${e.name}'`).join(', ')
            warnings.add(
              'warn_unexpected_entries',
              artistRel,
              `Unexpected file(s) in the artist folder: ${names}.`,
              { fix: FIX.warn_unexpected_entries }
            )
          }
        }

        for (const albumEntry of albumEntries) {
          if (!albumEntry.isDirectory()) continue

          const albumPath = path.join(artistPath, albumEntry.name)
          const albumRel = path.join(artistRel, albumEntry.name)
          const albumKey = makeAlbumKey(artistEntry.name, albumEntry.name)

          // Album folder validation — same approach as artist folder.
          if (rules.checks.warn_bad_album_folder && !albumFolderRegex.test(albumEntry.name)) {
            warnings.add(
              'warn_bad_album_folder',
              albumRel,
              `Folder name does not match patterns.album_folder.`,
              { fix: FIX.warn_bad_album_folder }
            )
          }
          if (rules.checks.warn_suspicious_folder_chars) {
            const issues = findSuspiciousPathChars(albumEntry.name)
            if (issues.length > 0) {
              warnings.add(
                'warn_suspicious_folder_chars',
                albumRel,
                `Suspicious characters in album folder: ${issues.join(', ')}.`,
                { fix: FIX.warn_suspicious_folder_chars }
              )
            }
          }

          let allFiles: fs.Dirent[]
          try {
            allFiles = fs.readdirSync(albumPath, { withFileTypes: true })
          } catch {
            warnings.add('permission_denied', albumRel, 'Permission denied reading album folder.', {
              fix: FIX.permission_denied,
            })
            continue
          }

          // Subfolders inside an album are silently ignored — files within
          // would be dropped from the catalog. Plex expects flat track
          // layout with disc-prefixed numbers for multi-disc albums.
          if (rules.checks.warn_extra_subfolders) {
            const subfolders = allFiles.filter(e => e.isDirectory())
            if (subfolders.length > 0) {
              const names = subfolders.map(s => `'${s.name}'`).join(', ')
              warnings.add(
                'warn_extra_subfolders',
                albumRel,
                `Unexpected subfolder(s) in the album folder: ${names}.`,
                { fix: FIX.warn_extra_subfolders }
              )
            }
          }

          // Non-media, non-sidecar files in album folder (cover.jpg, .nfo
          // allowed via sidecar list; random .zip, .txt, etc. not).
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
                albumRel,
                `Unexpected file(s) in the album folder: ${names}.`,
                { fix: FIX.warn_unexpected_entries }
              )
            }
          }

          const audioFiles = allFiles.filter(
            f => f.isFile() && hasExtension(f.name, rules.audio_extensions)
          )
          const nonPrimary = audioFiles.filter(f => !isPrimary(f.name, rules.primary_extension))

          if (audioFiles.length === 0) {
            if (rules.checks.warn_no_audio) {
              warnings.add('warn_no_audio', albumRel, 'Album folder has no audio files.', {
                fix: FIX.warn_no_audio,
              })
            }
            continue
          }

          if (rules.checks.warn_non_primary) {
            for (const f of nonPrimary) {
              const ext = path.extname(f.name).toLowerCase()
              warnings.add(
                'warn_non_primary',
                path.join(albumRel, f.name),
                `${formatPrimaryExts(rules.primary_extension)} audio file.`,
                { extension: ext, fix: FIX.warn_non_primary }
              )
            }
          }

          // Collect codecs from all audio file extensions (not just primary)
          // e.g. album with .flac and .mp3 -> codecs = { "FLAC", "MP3" }
          // Each codec pairs with the current category to form a Version.
          const codecs = new Set<string>()
          for (const f of audioFiles) {
            const ext = path.extname(f.name).slice(1).toUpperCase()
            codecs.add(ext)
          }

          // Track numbers per disc for gap detection: { discNum: [trackNums] }
          const discTracks = new Map<number, number[]>()
          let trackCount = 0

          for (const f of audioFiles) {
            const stem = path.basename(f.name, path.extname(f.name))
            const parsed = parseTrackStem(stem, multiDiscRegex, singleDiscRegex)

            if (!parsed) {
              if (rules.checks.warn_bad_track_name) {
                warnings.add(
                  'warn_bad_track_name',
                  path.join(albumRel, f.name),
                  `File name is not '01 - Track Name'.`,
                  { fix: FIX.warn_bad_track_name }
                )
              }
              continue
            }

            const { disc, track } = parsed
            trackCount++

            if (!discTracks.has(disc)) discTracks.set(disc, [])
            discTracks.get(disc)!.push(track)
          }

          if (rules.checks.warn_track_gaps) {
            for (const [discNum, tracks] of [...discTracks.entries()].sort(([a], [b]) => a - b)) {
              const gaps = findNumericGaps(tracks)
              if (gaps.length > 0) {
                const gapStr = formatGaps(gaps, g => String(g).padStart(2, '0'))
                const discStr = discTracks.size > 1 ? `Disc ${discNum}` : 'Album'
                warnings.add(
                  'warn_track_gaps',
                  albumRel,
                  `Missing tracks in ${discStr} (${gaps.length}): ${gapStr}.`,
                  { fix: FIX.warn_track_gaps }
                )
              }
            }
          }

          if (!records.has(artistKey)) {
            records.set(artistKey, {
              artist: artistEntry.name,
              albums: new Map(),
            })
          }

          const artistRecord = records.get(artistKey)!

          if (!artistRecord.albums.has(albumKey)) {
            artistRecord.albums.set(albumKey, {
              album: albumEntry.name,
              track_count: trackCount,
              versions: [],
            })
          } else {
            const existing = artistRecord.albums.get(albumKey)!
            existing.track_count = Math.max(existing.track_count, trackCount)
          }

          // One Version per (category, codec) pair. Deduped on serialize so
          // re-scans within the same category don't bloat the list.
          const album = artistRecord.albums.get(albumKey)!
          for (const codec of codecs) {
            album.versions.push({ category, quality: codec })
          }
        }
      }

      return records
    },

    merge(existing: Map<string, ArtistRecord>, incoming: Map<string, ArtistRecord>): void {
      for (const [artistKey, newArtist] of incoming) {
        if (!existing.has(artistKey)) {
          existing.set(artistKey, newArtist)
          continue
        }
        const existingArtist = existing.get(artistKey)!
        for (const [albumKey, newAlbum] of newArtist.albums) {
          if (!existingArtist.albums.has(albumKey)) {
            existingArtist.albums.set(albumKey, newAlbum)
          } else {
            const existingAlbum = existingArtist.albums.get(albumKey)!
            existingAlbum.versions.push(...newAlbum.versions)
            existingAlbum.track_count = Math.max(existingAlbum.track_count, newAlbum.track_count)
          }
        }
      }
    },

    serialize(records: Map<string, ArtistRecord>): ArtistOutput[] {
      return [...records.values()]
        .sort((a, b) => a.artist.toLowerCase().localeCompare(b.artist.toLowerCase()))
        .map(artist => ({
          artist: artist.artist,
          albums: [...artist.albums.values()]
            .sort((a, b) => a.album.toLowerCase().localeCompare(b.album.toLowerCase()))
            .map(album => ({
              album: album.album,
              track_count: album.track_count,
              versions: finalizeVersions(album.versions, categoryOrder),
            })),
        }))
    },

    /**
     * Post-merge check: emit one warning per album that ended up in multiple
     * categories. Cross-category sets listed in `acceptable_album_combos`
     * are silently passed.
     */
    postScan(records: Map<string, ArtistRecord>, warnings: WarningCollector): void {
      if (!rules.checks.warn_duplicate_album) return

      for (const artist of records.values()) {
        for (const album of artist.albums.values()) {
          const cats = distinctCategories(album.versions)
          if (cats.length <= 1) continue
          const catSet = new Set(cats)
          if (isAcceptableComboSet(catSet, rules.acceptable_album_combos)) continue
          const ordered = categoryOrder.filter(c => cats.includes(c))
          warnings.add(
            'warn_duplicate_album',
            path.join(artist.artist, album.album),
            `Also in ${ordered.length} other categories: ${ordered.join(', ')}.`,
            // The path carries no category — this check spans them by
            // definition — so scope derivation would read the artist as one.
            // Spelling it out is also what lets a `folders:` entry reach here.
            {
              fix: FIX.warn_duplicate_album,
              scope: { categories: ordered, levels: [artist.artist, album.album] },
            }
          )
        }
      }
    },
  }
}

/** Return true if `set` matches one of the acceptable category combos. */
function isAcceptableComboSet(set: Set<string>, combos: readonly string[][]): boolean {
  return combos.some(combo => combo.length === set.size && combo.every(c => set.has(c)))
}
