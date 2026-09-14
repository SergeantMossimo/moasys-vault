/**
 * core/rules/music.ts
 * -------------------
 * Schema, defaults, and inferred type for the Music rules layer.
 *
 * Mirrors the previously hardcoded patterns in src/media/music.ts.
 * Music has no constants beyond regex — just patterns and check toggles.
 */

import { z } from 'zod'

import { PatternSchema, CategorySchema } from './helpers'

export const MusicRulesSchema = z.object({
  /**
   * Regex patterns for folders and track file stems.
   *
   * Track stems: the scanner tries `multi_disc` first (more specific), then
   * `single_disc`. Single-disc files (e.g. "01 - Track Name") get disc 1.
   *
   * - `artist_folder` captures: name. Default matches any non-empty name —
   *   Plex itself doesn't specify a format for artist folders.
   * - `album_folder` captures: name. Same — Plex example: `/The Wall`, no year.
   * - `single_disc` captures: track, name
   * - `multi_disc` captures: disc, track, name
   *
   * Override `artist_folder` or `album_folder` if your library uses a stricter
   * convention (e.g. album folders that include the year in parens).
   */
  patterns: z.object({
    artist_folder: PatternSchema,
    album_folder: PatternSchema,
    single_disc: PatternSchema,
    multi_disc: PatternSchema,
  }),

  /** Subfolders under root_path to walk. Empty = walk root_path directly with "default" label. */
  categories: z.array(CategorySchema),

  /**
   * Expected primary file format(s) for music. Lossless-only libraries
   * might use [".flac"]; mixed libraries can list multiple, in which case
   * any of them is treated as "primary".
   */
  primary_extension: z.array(z.string()).min(1),

  /** All file extensions the scanner recognizes as audio files. */
  audio_extensions: z.array(z.string()).min(1),

  /**
   * File extensions for Plex sidecar files (NFO metadata, cover art,
   * lyrics, cuesheets). Silently allowed anywhere in the music hierarchy
   * and never flagged as "unexpected".
   */
  sidecar_extensions: z.array(z.string()),

  /**
   * Codec combinations that are intentional and should NOT trigger
   * `warn_quality_inconsistent`. Listed as quality sets — order doesn't
   * matter. Codec names use the same upper-case form as the album's
   * `audio_quality_summary` (FLAC, MP3, AAC, ALAC, OGG, WAV, etc.).
   *
   * Only applies to codec-MIX cases. Bitrate-spread cases within a single
   * codec (e.g. MP3 192 mixed with MP3 320) still fire the warning even
   * when [MP3] is whitelisted — for that, fix the encoding or silence the
   * specific album via `ignored/music.yaml`.
   */
  acceptable_codec_combos: z.array(z.array(z.string())),

  /**
   * Category sets in which the same album may legitimately appear without
   * firing `warn_duplicate_album`. Set-based comparison — order doesn't
   * matter. Example: the same album kept in both `Music` and `Soundtracks`
   * categories is whitelisted by listing `[Music, Soundtracks]`.
   *
   * Empty default — every cross-category duplicate fires the warning.
   */
  acceptable_album_combos: z.array(z.array(z.string())),

  /** Per-warning toggles. */
  checks: z.object({
    warn_non_primary: z.boolean(),
    warn_no_audio: z.boolean(),
    warn_bad_track_name: z.boolean(),
    warn_bad_artist_folder: z.boolean(),
    warn_bad_album_folder: z.boolean(),
    warn_suspicious_folder_chars: z.boolean(),
    warn_track_gaps: z.boolean(),
    warn_duplicate_album: z.boolean(),
    /**
     * Audio files found at a level where the scanner expects a subfolder.
     * Examples: tracks directly in the media folder (no artist), or tracks
     * directly in an artist folder (no album). Files at these levels are
     * silently dropped from the catalog without this warning enabled.
     */
    warn_loose_files: z.boolean(),
    /**
     * Subfolders inside an album folder, where Plex expects a flat track
     * layout. Multi-disc albums should use disc-prefixed numbers (101, 201)
     * rather than per-disc subfolders. Files inside such subfolders are
     * silently dropped without this warning enabled.
     */
    warn_extra_subfolders: z.boolean(),
    /**
     * Files that aren't audio, aren't recognized Plex sidecars, and aren't
     * known OS artifacts. Catches stray files silently ignored elsewhere.
     */
    warn_unexpected_entries: z.boolean(),
    /**
     * Album has tracks with more than one distinct derived audio quality
     * (e.g. some tracks FLAC 16/44.1 and others MP3 320). Usually means a
     * mid-album re-encode or accidental mix. Surfaced from the probe pass.
     */
    warn_quality_inconsistent: z.boolean(),
    /**
     * Album has tracks by multiple distinct artists (per embedded
     * AlbumArtist tags) but isn't in a "Various Artists" folder. Per Plex
     * convention, true compilations should live under Various Artists.
     */
    warn_compilation_detected: z.boolean(),
    /**
     * The artist or album folder on disk doesn't match what the embedded
     * tags say. Common cause of Plex library fragmentation — folder says
     * "Pink Floyd" but tag says "Pink Floyd Project" and they get treated
     * as separate artists.
     */
    warn_folder_tag_mismatch: z.boolean(),
    /**
     * An artist or album folder matches its ID3 tag except for
     * capitalization. Split out from `warn_folder_tag_mismatch`, which
     * lowercases both sides — see shows' warn_show_title_case.
     */
    warn_folder_tag_case: z.boolean(),
    /**
     * Tracks missing required tag fields (title, album, or album_artist /
     * artist). Plex falls back to filename parsing in this case, which
     * works but means you're not really benefiting from ID3.
     */
    warn_missing_tags: z.boolean(),
    /**
     * Filename's track number prefix (e.g. `03 -`) doesn't match the
     * embedded TrackNumber tag. Usually means an accidental rename or
     * out-of-order tracks.
     */
    warn_track_number_mismatch: z.boolean(),
    /**
     * Album contains tracks encoded as mono (single audio channel).
     * Per-album summary warning: "N of M tracks are mono". Most music
     * since the late 1950s is stereo; mono usually indicates a bad rip,
     * a downloaded preview, or an intentional historical recording.
     *
     * Legitimate mono albums (early jazz/blues, mono masters, etc.) can
     * be silenced per-album under `albums:` in `ignored/<drive>/music.yaml`
     * (which silences that album's other warnings too).
     */
    warn_mono_audio: z.boolean(),
  }),
})

export type MusicRules = z.infer<typeof MusicRulesSchema>

export const defaultMusicRules: MusicRules = MusicRulesSchema.parse({
  patterns: {
    // Permissive defaults — Plex has no required format for artist or album
    // folders. The named capture is there so callers and overrides can rely
    // on `match.groups.name` regardless of how strict the user's regex gets.
    artist_folder: '^(?<name>.+)$',
    album_folder: '^(?<name>.+)$',
    single_disc: '^(?<track>\\d{2})\\s-\\s(?<name>.+)$',
    multi_disc: '^(?<disc>\\d+)(?<track>\\d{2})\\s-\\s(?<name>.+)$',
  },
  categories: [],
  primary_extension: ['.flac', '.mp3', '.m4a'],
  audio_extensions: ['.flac', '.mp3', '.aac', '.m4a', '.wav', '.ogg', '.wma'],
  // Music sidecars — NFO metadata, cover art, lyrics, cuesheets, PDF liner notes.
  sidecar_extensions: [
    '.nfo',
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.lrc',
    '.cue',
    '.m3u',
    '.m3u8',
    '.pdf',
  ],
  // Empty by default — most users want every codec mix flagged. Add combos
  // here to whitelist intentional mixes (e.g. transitional FLAC + MP3 albums).
  acceptable_codec_combos: [],
  // Empty by default — every cross-category album duplicate fires the
  // warning. Add combos here when the same album lives in two categories
  // intentionally (e.g. a soundtrack kept in both Music and Soundtracks).
  acceptable_album_combos: [],
  checks: {
    warn_non_primary: true,
    warn_no_audio: true,
    warn_bad_track_name: true,
    warn_bad_artist_folder: true,
    warn_bad_album_folder: true,
    warn_suspicious_folder_chars: true,
    warn_track_gaps: true,
    warn_duplicate_album: true,
    warn_loose_files: true,
    warn_extra_subfolders: true,
    warn_unexpected_entries: true,
    warn_quality_inconsistent: true,
    warn_compilation_detected: true,
    warn_folder_tag_mismatch: true,
    warn_folder_tag_case: true,
    warn_missing_tags: true,
    warn_track_number_mismatch: true,
    warn_mono_audio: true,
  },
})
