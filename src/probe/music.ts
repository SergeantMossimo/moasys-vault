/**
 * probe/music.ts
 * --------------
 * ffprobe pass for music — walks the library and records per-track probe data.
 *
 * Music quality is codec + bitrate + sample rate + bit depth rather than
 * dimensions, so there's no quality_mismatch here. The probe-side checks are
 * per album: mixed track quality (warn_quality_inconsistent), mono audio,
 * missing durations, and the embedded-tag checks — missing tags, track
 * numbers, folder/tag names, compilations.
 */

import fs from 'fs'
import path from 'path'

import { DirReader } from '../core/dir-reader'
import { MusicConfig, WarningCollector } from '../core/types'
import { hasExtension, isPrimary, toComparableFolderName, toRel } from '../core/files'
import { MusicRules } from '../core/rules/music'
import {
  categoryPath,
  compilePattern,
  isAcceptableCombo,
  isRealCategory,
  resolveCategories,
} from '../core/rules/helpers'
import { listWithMore, quotedList } from '../core/gaps'
import { makeAlbumKey, makeArtistKey, parseTrackStem } from '../media/music'

import { ProbeCache } from './cache'
import { ProbeTask, ProbedFile, logProbeProgress, probeBatch } from './helpers'
import { readTags } from './id3'
import { deriveAudioQuality, summarizeAlbumQuality } from './music-quality'
import { ArtistProbeOutput, AlbumProbeOutput, TrackProbe, ProbeData, ProbeResult } from './types'

/**
 * The remedy for the tag checks that fire from more than one call site, kept
 * in one map so each bucket's `fix` reads the same whichever site produced the
 * row — the artist and album comparisons share both of these. See
 * `WarningOptions.fix`.
 */
const FIX = {
  warn_folder_tag_mismatch:
    `Rename the folder, or correct the tag — whichever is wrong. Plex catalogues from the ` +
    `tag, so a mismatch files the album under one name while you browse for another.`,
  warn_folder_tag_case: `Make them agree, so Plex and your filesystem don't present one name two ways.`,
} as const

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

interface TrackIdentity {
  artist: string
  album: string
  mediaType: string
  disc: number
  track: number
}

/**
 * Build a warning path for an album-level finding. Prepends the first
 * category from `media_type` so users can locate the album in libraries
 * organized by subfolder. A flat library (no categories) gets no prefix.
 */
function albumWarningPath(mediaType: string[], artist: string, album: string): string {
  return categoryPath(mediaType[0], artist, album)
}

/**
 * The ignore-list scope for an album-level finding.
 *
 * `albumWarningPath` can only display ONE category, but an album may sit in
 * several; handing the matcher all of them keeps a `folders:` entry from
 * depending on which one happened to come first. The levels are spelled out
 * rather than derived because the displayed path drops the category entirely
 * in a flat library, which would shift every level by one.
 */
function albumWarningScope(
  mediaType: string[],
  artist: string,
  album: string
): { categories: string[]; levels: string[] } {
  return {
    categories: [...new Set(mediaType)].filter(isRealCategory),
    levels: [artist, album],
  }
}

/**
 * Pull the codec name (e.g. "FLAC", "MP3", "AAC") out of an
 * `audio_quality_summary` entry like "FLAC 16/44.1" or "MP3 ~288".
 * Entries always start with the codec followed by a space, so the first
 * whitespace-delimited token is the codec.
 */
function codecFromQualityEntry(entry: string): string {
  const space = entry.indexOf(' ')
  return space === -1 ? entry : entry.slice(0, space)
}

/**
 * An album's quality summary as a warning can hold it. A VBR album whose
 * bitrates spread past the tolerance lists one entry per rate — 29 of them for
 * one soundtrack — so a codec with more than `RANGE_AFTER` lossy rates
 * becomes a range: `MP3 196–280 (29 bitrates)`.
 */
export function describeQualityMix(summary: string[]): string {
  const RANGE_AFTER = 4
  const lossy = new Map<string, number[]>()
  for (const entry of summary) {
    const m = /^(\S+) ~?(\d+)$/.exec(entry)
    if (m) lossy.set(m[1]!, [...(lossy.get(m[1]!) ?? []), Number(m[2])])
  }
  const parts: string[] = []
  const ranged = new Set<string>()
  for (const entry of summary) {
    const codec = codecFromQualityEntry(entry)
    const rates = lossy.get(codec)
    if (!rates || rates.length <= RANGE_AFTER || !/^\S+ ~?\d+$/.test(entry)) {
      parts.push(entry)
    } else if (!ranged.has(codec)) {
      ranged.add(codec)
      parts.push(`${codec} ${Math.min(...rates)}–${Math.max(...rates)} (${rates.length} bitrates)`)
    }
  }
  return listWithMore(parts, 6)
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

function collectTasks(
  config: MusicConfig,
  rules: MusicRules,
  dir: DirReader
): Array<{ task: ProbeTask; identity: TrackIdentity }> {
  const multiDiscRegex = compilePattern(rules.patterns.multi_disc)
  const singleDiscRegex = compilePattern(rules.patterns.single_disc)
  const out: Array<{ task: ProbeTask; identity: TrackIdentity }> = []

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

    for (const artistEntry of topEntries) {
      if (!artistEntry.isDirectory()) continue
      const artistPath = path.join(folderPath, artistEntry.name)

      let albumEntries: fs.Dirent[]
      try {
        albumEntries = dir.readdir(artistPath)
      } catch {
        continue
      }

      for (const albumEntry of albumEntries) {
        if (!albumEntry.isDirectory()) continue
        const albumPath = path.join(artistPath, albumEntry.name)

        let files: fs.Dirent[]
        try {
          files = dir.readdir(albumPath)
        } catch {
          continue
        }

        for (const f of files) {
          if (!f.isFile()) continue
          // Music probes ALL audio extensions (not just primary) because the
          // probe data itself is the signal — non-primary files often still
          // matter for the album-quality picture.
          if (!hasExtension(f.name, rules.audio_extensions)) continue
          // But only probe primary files for cache efficiency in the MVP.
          // Revisit if cross-format album analysis becomes important.
          if (!isPrimary(f.name, rules.primary_extension)) continue

          const stem = path.basename(f.name, path.extname(f.name))
          const parsed = parseTrackStem(stem, multiDiscRegex, singleDiscRegex)
          if (!parsed) continue

          const absolutePath = path.join(albumPath, f.name)
          let stat: fs.Stats
          try {
            stat = fs.statSync(absolutePath)
          } catch {
            continue
          }

          out.push({
            task: {
              relativePath: toRel(
                path.join(cat.folderName, artistEntry.name, albumEntry.name, f.name)
              ),
              absolutePath,
              category: cat.name,
              quality: cat.quality,
              mtime: stat.mtimeMs,
              size: stat.size,
            },
            identity: {
              artist: artistEntry.name,
              album: albumEntry.name,
              mediaType: cat.name,
              disc: parsed.disc,
              track: parsed.track,
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
  identities: Map<string, TrackIdentity>,
  mediaTypeOrder: string[]
): ArtistProbeOutput[] {
  const artists = new Map<string, { artist: string; albums: Map<string, AlbumProbeOutput> }>()

  for (const { task, data } of probed) {
    const id = identities.get(task.relativePath)
    if (!id) continue

    const aKey = makeArtistKey(id.artist)
    let artist = artists.get(aKey)
    if (!artist) {
      artist = { artist: id.artist, albums: new Map() }
      artists.set(aKey, artist)
    }

    const albKey = makeAlbumKey(id.artist, id.album)
    let album = artist.albums.get(albKey)
    if (!album) {
      album = { album: id.album, media_type: [], audio_quality_summary: [], tracks: [] }
      artist.albums.set(albKey, album)
    }
    if (!album.media_type.includes(id.mediaType)) album.media_type.push(id.mediaType)

    const track: TrackProbe = {
      category: task.category,
      path: task.relativePath,
      disc: id.disc,
      track: id.track,
      size_bytes: data.size_bytes,
      duration_seconds: data.duration_seconds,
      bitrate: data.bitrate,
      video: data.video,
      audio: data.audio,
      tags: data.tags,
      audio_quality: deriveAudioQuality(data.audio, data.bitrate),
    }
    album.tracks.push(track)
  }

  // Sort media_type lists by configured order; sort tracks by disc then track.
  // Derive each album's audio_quality_summary via summarizeAlbumQuality which
  // collapses VBR variance and only surfaces real inconsistencies.
  const mtIndex = (m: string) => {
    const i = mediaTypeOrder.indexOf(m)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  for (const artist of artists.values()) {
    for (const album of artist.albums.values()) {
      album.media_type.sort((a, b) => mtIndex(a) - mtIndex(b))
      album.tracks.sort((a, b) => (a.disc !== b.disc ? a.disc - b.disc : a.track - b.track))
      album.audio_quality_summary = summarizeAlbumQuality(album.tracks)
    }
  }

  return [...artists.values()]
    .sort((a, b) => a.artist.toLowerCase().localeCompare(b.artist.toLowerCase()))
    .map(artist => ({
      artist: artist.artist,
      albums: [...artist.albums.values()].sort((a, b) =>
        a.album.toLowerCase().localeCompare(b.album.toLowerCase())
      ),
    }))
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

/**
 * Run the music probe pass end-to-end: walk the library, probe each track
 * (cache-aware, with its embedded tags), summarize each album's audio quality,
 * and emit the per-album quality and tag warnings. Cache writes are the
 * caller's responsibility.
 */
export async function probeMusic(
  config: MusicConfig,
  rules: MusicRules,
  cache: ProbeCache,
  warnings: WarningCollector,
  dir: DirReader = new DirReader()
): Promise<ProbeResult<ArtistProbeOutput[]>> {
  const collected = collectTasks(config, rules, dir)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  const identities = new Map<string, TrackIdentity>()
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
  const aggregated = aggregate(probed, identities, mediaTypeOrder)

  // Quality inconsistency check — runs after aggregation since we need the
  // full per-album audio_quality_summary to know if there's a mismatch.
  //
  // Codec-mix cases that match `acceptable_codec_combos` are silently passed.
  // Bitrate-spread cases within a single codec still fire — the whitelist
  // only suppresses codec-mix noise (FLAC + MP3 etc.).
  if (rules.checks.warn_quality_inconsistent) {
    for (const artist of aggregated) {
      for (const album of artist.albums) {
        if (album.audio_quality_summary.length <= 1) continue

        const codecs = new Set(album.audio_quality_summary.map(codecFromQualityEntry))
        const isCodecMix = codecs.size > 1
        if (isCodecMix && isAcceptableCombo(codecs, rules.acceptable_codec_combos)) {
          continue
        }

        warnings.add(
          'warn_quality_inconsistent',
          albumWarningPath(album.media_type, artist.artist, album.album),
          `Mixed track quality: ${describeQualityMix(album.audio_quality_summary)}.`,
          {
            fix:
              `Usually a mid-album re-encode, or files added at different bitrates. Re-encode ` +
              `the outliers to match the rest of the album.`,
            scope: albumWarningScope(album.media_type, artist.artist, album.album),
          }
        )
      }
    }
  }

  // Mono-audio check — modern music is stereo, so an album of mono tracks
  // usually indicates a bad rip or a downloaded preview. Per-album summary
  // ("N of M tracks are mono") so we don't drown warnings.json in per-track
  // entries. Legitimate mono albums (pre-stereo recordings, mono masters)
  // can be silenced per-album via ignored/music.yaml.
  if (rules.checks.warn_mono_audio) {
    for (const artist of aggregated) {
      for (const album of artist.albums) {
        let mono = 0
        let totalWithAudio = 0
        for (const track of album.tracks) {
          if (!track.audio || track.audio.channels === null) continue
          totalWithAudio++
          if (track.audio.channels === 1) mono++
        }
        if (mono === 0) continue
        warnings.add(
          'warn_mono_audio',
          albumWarningPath(album.media_type, artist.artist, album.album),
          `${mono}/${totalWithAudio} tracks are mono (one audio channel).`,
          {
            fix:
              `Most music since the late 1950s is stereo, so mono usually means a bad rip or a ` +
              `preview download — re-rip from a stereo source. Expected on pre-stereo recordings ` +
              `and mono masters.`,
            scope: albumWarningScope(album.media_type, artist.artist, album.album),
          }
        )
      }
    }
  }

  // Missing-duration check — ffprobe read the audio stream but the header
  // records no length, so there's nothing to report a runtime from. The file
  // still decodes; players just can't show or seek by time. Per-album summary,
  // like the mono check. Tracks with no audio stream are left out — that's a
  // different problem, not a header one.
  if (rules.checks.warn_missing_duration) {
    for (const artist of aggregated) {
      for (const album of artist.albums) {
        const withAudio = album.tracks.filter(t => t.audio !== null)
        const missing = withAudio.filter(t => t.duration_seconds === null)
        if (missing.length === 0) continue
        const names = quotedList(
          missing.map(t => path.posix.basename(t.path)),
          3
        )
        warnings.add(
          'warn_missing_duration',
          albumWarningPath(album.media_type, artist.artist, album.album),
          `${missing.length}/${withAudio.length} tracks have no length in their header: ` +
            `${names}.`,
          {
            fix:
              `The file plays, but its header doesn't record its length, so players can show ` +
              `0:00 or fail to seek. Re-encoding the file rewrites the header.`,
            scope: albumWarningScope(album.media_type, artist.artist, album.album),
          }
        )
      }
    }
  }

  // Tag-driven checks. An album with no readable tags is skipped inside, so
  // a library without ID3 data costs nothing here.
  analyzeTags(aggregated, rules, warnings)

  const byPath = new Map<string, ProbeData>()
  for (const { task, data } of probed) byPath.set(task.relativePath, data)

  return { output: aggregated, byPath }
}

// ─────────────────────────────────────────────
// Tag analysis (compilation, mismatch, missing, track-number)
// ─────────────────────────────────────────────

/**
 * Compare a tag value against a folder name, allowing for Windows-illegal
 * characters in the tag that the user had to drop from the folder.
 *
 * Example: ID3 `AlbumArtist` is `AC/DC` but the folder is `ACDC` because
 * forward slashes can't appear in folder names. We strip illegal chars
 * from the tag side before comparing — the folder is the filename-safe
 * form of the tag, and that's a legitimate match.
 *
 * Returns which of three things is true, rather than a boolean, because
 * capitalization-only drift ('Talespin' vs 'TaleSpin') deserves its own
 * lower-severity warning: it fragments a Plex library exactly the way a real
 * mismatch does, but the fix is trivial and it shouldn't crowd out genuine
 * mismatches. Same split as `warn_show_title_case` in media/shows.ts.
 *
 *   'match'      — identical once illegal chars and surrounding space are gone
 *   'case-only'  — equal ignoring case, different byte-for-byte
 *   'mismatch'   — genuinely different values
 */
type TagFolderComparison = 'match' | 'case-only' | 'mismatch'

function compareTagToFolder(tagValue: string, folderName: string): TagFolderComparison {
  const tagSafe = toComparableFolderName(tagValue)
  const folder = folderName.trim()
  if (tagSafe === folder) return 'match'
  if (tagSafe.toLowerCase() === folder.toLowerCase()) return 'case-only'
  return 'mismatch'
}

/**
 * Pick the form of a tag value the user could actually use as a folder name.
 * Strips Windows-illegal characters (`AC/DC` → `ACDC`) and Windows-stripped
 * trailing positions (`P.O.D.` → `P.O.D`) so the recommended-fix message
 * never tells the user to do something the OS won't let them do.
 */
function suggestedFolderName(tagValue: string): string {
  const safe = toComparableFolderName(tagValue)
  return safe === tagValue ? tagValue : safe
}

/** Is this string the literal Plex "Various Artists" convention? */
function isVariousArtists(s: string): boolean {
  return s.trim().toLowerCase() === 'various artists'
}

/**
 * Run all four ID3-driven checks against the aggregated probe results.
 * Each toggle is gated by its own `rules.checks.warn_*` so users can silence
 * individual checks without losing the others.
 */
function analyzeTags(
  aggregated: ArtistProbeOutput[],
  rules: MusicRules,
  warnings: WarningCollector
): void {
  for (const artist of aggregated) {
    for (const album of artist.albums) {
      const albumPath = albumWarningPath(album.media_type, artist.artist, album.album)
      const albumOpts = {
        scope: albumWarningScope(album.media_type, artist.artist, album.album),
      }

      // Collect distinct album_artist values (fall back to artist when
      // album_artist is missing — many older rips only set artist).
      const albumArtistSet = new Set<string>()
      const albumNameSet = new Set<string>()
      let tracksWithTags = 0
      const missingTagsTracks: string[] = []
      const trackNumberMismatches: Array<{ filename: string; tag: number; expected: number }> = []

      for (const t of album.tracks) {
        if (!t.tags) continue
        tracksWithTags++

        const albumArtist = (t.tags.album_artist ?? t.tags.artist)?.trim()
        if (albumArtist) albumArtistSet.add(albumArtist)
        if (t.tags.album) albumNameSet.add(t.tags.album.trim())

        // Missing required tags: title and album always needed; artist OR
        // album_artist needed.
        const hasArtistish = (t.tags.artist || t.tags.album_artist)?.trim()
        if (!t.tags.title || !t.tags.album || !hasArtistish) {
          missingTagsTracks.push(path.posix.basename(t.path))
        }

        // Track-number mismatch: only flag when the tag is present and
        // differs from the filename track number.
        if (t.tags.track !== null && t.tags.track !== t.track) {
          trackNumberMismatches.push({
            filename: path.posix.basename(t.path),
            tag: t.tags.track,
            expected: t.track,
          })
        }
      }

      // Skip the album entirely when no tracks had readable tags — nothing
      // to compare against.
      if (tracksWithTags === 0) continue

      // ── Compilation detection ────────────────────────────────────────
      // Multiple distinct album_artist values = real compilation. Should
      // live under "Various Artists" per Plex docs.
      if (
        rules.checks.warn_compilation_detected &&
        albumArtistSet.size > 1 &&
        !isVariousArtists(artist.artist)
      ) {
        const sample = listWithMore([...albumArtistSet], 5)
        warnings.add(
          'warn_compilation_detected',
          albumPath,
          `${albumArtistSet.size} distinct AlbumArtist tags (${sample}), but not under ` +
            `'Various Artists'.`,
          {
            ...albumOpts,
            fix:
              `Move the album to '<category>/Various Artists/<Album>/' and set every track's ` +
              `AlbumArtist tag to 'Various Artists'. The per-track Artist tag stays the actual ` +
              `performer.`,
          }
        )
      }

      // ── Folder/tag mismatch ──────────────────────────────────────────
      // Single consistent album_artist that disagrees with the artist
      // folder name. Common Plex library fragmentation cause.
      if (albumArtistSet.size === 1) {
        const tagValue = [...albumArtistSet][0]!
        const comparison = compareTagToFolder(tagValue, artist.artist)
        if (comparison === 'mismatch' && rules.checks.warn_folder_tag_mismatch) {
          warnings.add(
            'warn_folder_tag_mismatch',
            albumPath,
            `Artist folder is '${artist.artist}', AlbumArtist tag is '${tagValue}'. ` +
              `Suggested folder: '${suggestedFolderName(tagValue)}'.`,
            { ...albumOpts, fix: FIX.warn_folder_tag_mismatch }
          )
        } else if (comparison === 'case-only' && rules.checks.warn_folder_tag_case) {
          warnings.add(
            'warn_folder_tag_case',
            albumPath,
            `Capitalization only: artist folder '${artist.artist}' vs AlbumArtist tag ` +
              `'${tagValue}'.`,
            { ...albumOpts, fix: FIX.warn_folder_tag_case }
          )
        }
      }

      // Album name mismatch — same idea, different field.
      if (albumNameSet.size === 1) {
        const tagValue = [...albumNameSet][0]!
        const comparison = compareTagToFolder(tagValue, album.album)
        if (comparison === 'mismatch' && rules.checks.warn_folder_tag_mismatch) {
          warnings.add(
            'warn_folder_tag_mismatch',
            albumPath,
            `Album folder is '${album.album}', Album tag is '${tagValue}'. ` +
              `Suggested folder: '${suggestedFolderName(tagValue)}'.`,
            { ...albumOpts, fix: FIX.warn_folder_tag_mismatch }
          )
        } else if (comparison === 'case-only' && rules.checks.warn_folder_tag_case) {
          warnings.add(
            'warn_folder_tag_case',
            albumPath,
            `Capitalization only: album folder '${album.album}' vs Album tag '${tagValue}'.`,
            { ...albumOpts, fix: FIX.warn_folder_tag_case }
          )
        }
      }

      // ── Missing tags ─────────────────────────────────────────────────
      if (rules.checks.warn_missing_tags && missingTagsTracks.length > 0) {
        const sample = quotedList(missingTagsTracks, 3)
        warnings.add(
          'warn_missing_tags',
          albumPath,
          `${missingTagsTracks.length} tracks missing title, album or artist tags: ${sample}.`,
          {
            ...albumOpts,
            fix: `Plex falls back to parsing the filename for these. Tag them for cleaner metadata.`,
          }
        )
      }

      // ── Track-number mismatch ────────────────────────────────────────
      if (rules.checks.warn_track_number_mismatch && trackNumberMismatches.length > 0) {
        const sample = listWithMore(
          trackNumberMismatches.map(m => `'${m.filename}' (filename=${m.expected}, tag=${m.tag})`),
          3,
          '; '
        )
        warnings.add(
          'warn_track_number_mismatch',
          albumPath,
          `${trackNumberMismatches.length} tracks whose number differs between filename and tag: ` +
            `${sample}.`,
          {
            ...albumOpts,
            fix: `Usually an accidental rename — check the tag is right, then rename the file.`,
          }
        )
      }
    }
  }
}
