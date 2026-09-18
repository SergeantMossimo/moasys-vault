/**
 * probe/music.ts
 * --------------
 * ffprobe pass for music — walks the library and records per-track probe data.
 *
 * No quality_mismatch logic: music quality is codec + bitrate + sample rate +
 * bit depth rather than dimensions. The probe pass collects all of those and
 * leaves analysis to the website (or a future warning pass).
 */

import fs from 'fs'
import path from 'path'

import { MusicConfig, WarningCollector } from '../core/types'
import { hasExtension, isPrimary } from '../core/files'
import { MusicRules } from '../core/rules/music'
import { compilePattern, resolveCategories } from '../core/rules/helpers'

import { toComparableFolderName } from '../core/files'

import { ProbeCache } from './cache'
import { ProbeTask, ProbedFile, probeBatch } from './helpers'
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

function parseTrackStem(
  stem: string,
  multiDiscRegex: RegExp,
  singleDiscRegex: RegExp
): { disc: number; track: number } | null {
  const mm = multiDiscRegex.exec(stem)
  if (mm?.groups) {
    const { disc, track } = mm.groups
    if (disc !== undefined && track !== undefined) {
      return { disc: parseInt(disc, 10), track: parseInt(track, 10) }
    }
  }
  const sm = singleDiscRegex.exec(stem)
  if (sm?.groups) {
    const { track } = sm.groups
    if (track !== undefined) return { disc: 1, track: parseInt(track, 10) }
  }
  return null
}

function artistKey(a: string): string {
  return a.toLowerCase()
}

function albumKey(a: string, al: string): string {
  return `${a.toLowerCase()}|${al.toLowerCase()}`
}

function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Build a warning path for an album-level finding. Prepends the first
 * category from `media_type` so users can locate the album in libraries
 * organized by subfolder. The "default" sentinel (empty categories config)
 * is skipped so flat libraries stay clean. WarningCollector normalizes the
 * backslashes that path.join produces on Windows.
 */
function albumWarningPath(mediaType: string[], artist: string, album: string): string {
  const category = mediaType[0]
  return category && category !== 'default'
    ? path.join(category, artist, album)
    : path.join(artist, album)
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
    categories: [...new Set(mediaType)].filter(c => c !== 'default'),
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

/** Return true if `codecs` matches one of the acceptable combos (set equality). */
function isAcceptableCodecCombo(codecs: Set<string>, combos: readonly string[][]): boolean {
  return combos.some(combo => combo.length === codecs.size && combo.every(c => codecs.has(c)))
}

// ─────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────

function collectTasks(
  config: MusicConfig,
  rules: MusicRules
): Array<{ task: ProbeTask; identity: TrackIdentity }> {
  const multiDiscRegex = compilePattern(rules.patterns.multi_disc)
  const singleDiscRegex = compilePattern(rules.patterns.single_disc)
  const out: Array<{ task: ProbeTask; identity: TrackIdentity }> = []

  for (const cat of resolveCategories(rules.categories)) {
    const folderPath = path.join(config.root_path, cat.folderName)
    // Missing folders are reported once, by the scan pass (core/scanner.ts).
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue

    for (const artistEntry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!artistEntry.isDirectory()) continue
      const artistPath = path.join(folderPath, artistEntry.name)

      let albumEntries: fs.Dirent[]
      try {
        albumEntries = fs.readdirSync(artistPath, { withFileTypes: true })
      } catch {
        continue
      }

      for (const albumEntry of albumEntries) {
        if (!albumEntry.isDirectory()) continue
        const albumPath = path.join(artistPath, albumEntry.name)

        let files: fs.Dirent[]
        try {
          files = fs.readdirSync(albumPath, { withFileTypes: true })
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

    const aKey = artistKey(id.artist)
    let artist = artists.get(aKey)
    if (!artist) {
      artist = { artist: id.artist, albums: new Map() }
      artists.set(aKey, artist)
    }

    const albKey = albumKey(id.artist, id.album)
    let album = artist.albums.get(albKey)
    if (!album) {
      album = { album: id.album, media_type: [], audio_quality_summary: [], tracks: [] }
      artist.albums.set(albKey, album)
    }
    if (!album.media_type.includes(id.mediaType)) album.media_type.push(id.mediaType)

    const track: TrackProbe = {
      quality: task.category,
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

export async function probeMusic(
  config: MusicConfig,
  rules: MusicRules,
  cache: ProbeCache,
  warnings: WarningCollector
): Promise<ProbeResult<ArtistProbeOutput[]>> {
  const collected = collectTasks(config, rules)
  console.log(`    [PROBE] ${collected.length} primary files to probe`)

  const identities = new Map<string, TrackIdentity>()
  for (const { task, identity } of collected) identities.set(task.relativePath, identity)

  const tasks = collected.map(c => c.task)
  const probed = await probeBatch(
    tasks,
    cache,
    (done, total, cached) => {
      if (done === total || done % 100 === 0) {
        console.log(`    [PROBE] ${done}/${total} (${cached} cached)`)
      }
    },
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
        if (isCodecMix && isAcceptableCodecCombo(codecs, rules.acceptable_codec_combos)) {
          continue
        }

        warnings.add(
          'warn_quality_inconsistent',
          albumWarningPath(album.media_type, artist.artist, album.album),
          `Mixed track quality: ${album.audio_quality_summary.join(', ')}.`,
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

  // Tag-driven checks — only run when at least one track in any album has
  // tags. Saves time on libraries without ID3 data (rare but possible).
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
          missingTagsTracks.push(t.path)
        }

        // Track-number mismatch: only flag when the tag is present and
        // differs from the filename track number.
        if (t.tags.track !== null && t.tags.track !== t.track) {
          trackNumberMismatches.push({
            filename: t.path,
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
        const sample = [...albumArtistSet].slice(0, 5).join(', ')
        const more = albumArtistSet.size > 5 ? `, ... +${albumArtistSet.size - 5} more` : ''
        warnings.add(
          'warn_compilation_detected',
          albumPath,
          `${albumArtistSet.size} distinct AlbumArtist tags (${sample}${more}), but not under ` +
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
        const sample = missingTagsTracks
          .slice(0, 3)
          .map(p => `'${p}'`)
          .join(', ')
        const more = missingTagsTracks.length > 3 ? `, +${missingTagsTracks.length - 3} more` : ''
        warnings.add(
          'warn_missing_tags',
          albumPath,
          `${missingTagsTracks.length} tracks missing title, album or artist tags: ${sample}${more}.`,
          {
            ...albumOpts,
            fix: `Plex falls back to parsing the filename for these. Tag them for cleaner metadata.`,
          }
        )
      }

      // ── Track-number mismatch ────────────────────────────────────────
      if (rules.checks.warn_track_number_mismatch && trackNumberMismatches.length > 0) {
        const sample = trackNumberMismatches
          .slice(0, 3)
          .map(m => `'${m.filename}' (filename=${m.expected}, tag=${m.tag})`)
          .join('; ')
        const more =
          trackNumberMismatches.length > 3 ? `; +${trackNumberMismatches.length - 3} more` : ''
        warnings.add(
          'warn_track_number_mismatch',
          albumPath,
          `${trackNumberMismatches.length} tracks whose number differs between filename and tag: ` +
            `${sample}${more}.`,
          {
            ...albumOpts,
            fix: `Usually an accidental rename — check the tag is right, then rename the file.`,
          }
        )
      }
    }
  }
}
