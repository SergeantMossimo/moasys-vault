/**
 * probe/types.ts
 * --------------
 * Shared types for the ffprobe layer.
 *
 * ProbeData is the trimmed, normalized shape we keep — only the fields that
 * matter for library hygiene and the website display. Raw ffprobe JSON has
 * dozens of fields per stream; storing all of it would bloat the cache for
 * no benefit.
 */

// ─────────────────────────────────────────────
// Probe data
// ─────────────────────────────────────────────

/** Video stream summary. Null for audio-only files. */
export interface VideoProbe {
  codec: string // e.g. "h264", "hevc"
  width: number // pixels
  height: number // pixels
  /** Frames per second. Null when ffprobe couldn't determine it. */
  frame_rate: number | null
}

/** Audio stream summary. Null when no audio streams exist (rare for our use). */
export interface AudioProbe {
  codec: string // e.g. "flac", "mp3", "aac"
  /** Bits per second. Null for VBR/lossless where ffprobe didn't report it. */
  bitrate: number | null
  /** Hz. */
  sample_rate: number | null
  /** Bits per sample, e.g. 16 or 24 for lossless. Null for lossy. */
  bit_depth: number | null
  channels: number | null
}

/**
 * Embedded tag metadata from an audio file's container (ID3 for MP3,
 * Vorbis comments for FLAC/OGG, MP4 tags for M4A, etc.). Populated by the
 * music and audiobooks probes — movies and shows don't read tags.
 *
 * All fields are nullable since tag presence varies widely across libraries.
 * Fall back from `album_artist` to `artist` when comparing against folder
 * names: many files only set `artist`, leaving `album_artist` unset.
 */
export interface TagData {
  /** Track title, e.g. "In the Flesh" */
  title: string | null
  /** Per-track artist — the performer of this track */
  artist: string | null
  /** Album-level artist — the artist responsible for the album as a whole */
  album_artist: string | null
  /** Album name from tags */
  album: string | null
  /** Release year as an integer, or null if missing/unparseable */
  year: number | null
  /** Track number (within disc), e.g. 1 of 12 */
  track: number | null
  /** Total tracks on this disc, or null if unset */
  total_tracks: number | null
  /** Disc number (1-indexed) for multi-disc albums */
  disc: number | null
  /** Total discs in the set, or null if unset */
  total_discs: number | null
  /** Genre tags (often multiple) */
  genre: string[] | null
}

/**
 * Normalized probe result for one file.
 * size_bytes / duration come from the container; video/audio from streams;
 * tags from the music probe pass when applicable.
 */
export interface ProbeData {
  size_bytes: number
  duration_seconds: number | null
  /** Container-level bitrate in bits/sec. Often the only bitrate available. */
  bitrate: number | null
  video: VideoProbe | null
  audio: AudioProbe | null
  /** Embedded metadata tags. Populated by the music and audiobooks probe passes. */
  tags: TagData | null
  /**
   * True once a tag read has been attempted for this file, whatever it found.
   * Distinguishes "read, no tags" from "never read" — a cache entry written
   * by a pass that didn't read tags also has `tags: null`, and without this
   * flag enabling tags for that pass would never backfill them. Absent on
   * entries that predate the flag.
   */
  tags_read?: boolean
}

// ─────────────────────────────────────────────
// Cache shape
// ─────────────────────────────────────────────

/**
 * One persisted cache entry. The path/mtime/size triple is the cache key —
 * if any of them differ for a file on disk, we re-probe.
 *
 * `path` is stored relative to the media root_path, with forward slashes,
 * so a cache built on Windows stays valid if the same library is mounted
 * later on macOS or Linux.
 */
export interface CacheEntry {
  path: string
  mtime: number // milliseconds since epoch
  size: number // bytes
  data: ProbeData
}

/** On-disk format of cache/<type>-probe.json */
export interface CacheFile {
  /** Schema version — bump if the ProbeData shape ever changes incompatibly. */
  version: number
  entries: CacheEntry[]
}

// Bumped when probe data shape changes incompatibly. Old caches get
// discarded; the next run rebuilds them.
//   v2: filter attached_pic streams from video summary
//   v3: ProbeData carries optional ID3 tag data for music files
export const CACHE_VERSION = 3

// ─────────────────────────────────────────────
// Probe result envelope
// ─────────────────────────────────────────────

/**
 * What each probe pass returns. `output` is the aggregated per-type shape
 * written to probe.json. `byPath` is a flat lookup map (forward-slash
 * relative path → raw probe data) that the scan pass uses to derive each
 * version's quality field.
 */
export interface ProbeResult<T> {
  output: T
  byPath: Map<string, ProbeData>
}

// ─────────────────────────────────────────────
// Per-media probe output shapes
// ─────────────────────────────────────────────

/**
 * Single-file row used in every per-media probe output. ProbeData fields are
 * flattened in (size_bytes, video, audio, etc.) rather than nested under a
 * `data:` key — easier for the website to render.
 */
export interface FileProbe extends ProbeData {
  /** Folder tag from config.json — UHD, HD, Music, Audible, etc. */
  quality: string
  /** Path relative to the media root, forward slashes. */
  path: string
}

// Movies
export interface MovieProbeOutput {
  title: string
  year: number
  edition: string | null
  files: FileProbe[]
}

// Shows
export interface EpisodeProbe extends FileProbe {
  /** Plex-style episode identifier, e.g. "S01E01" or "S01E01-E02". */
  episode: string
}

export interface ShowSeasonProbe {
  season: string // "1", "Specials", etc.
  episodes: EpisodeProbe[]
}

export interface ShowProbeOutput {
  title: string
  year: number
  seasons: ShowSeasonProbe[]
}

// Music
export interface TrackProbe extends FileProbe {
  disc: number
  track: number
  /**
   * Derived human-readable audio-quality string: `"FLAC 16/44.1"`, `"MP3 320"`,
   * `"AAC 256"`, etc. Null when ffprobe didn't return enough info to derive
   * one (rare). Computed from the audio stream's codec + bit_depth + sample
   * rate (lossless) or bitrate (lossy).
   *
   * Distinct from `FileProbe.quality`, which is the folder tag (e.g. "Music",
   * "Soundtracks"). This field describes encoded audio quality.
   */
  audio_quality: string | null
}

export interface AlbumProbeOutput {
  album: string
  media_type: string[]
  /**
   * Distinct audio-quality strings across all tracks in the album. One entry
   * = a uniform album. Multiple entries = mid-album quality changes, which
   * is usually a hygiene issue (e.g. one track was re-encoded at a lower
   * bitrate) and triggers `warn_quality_inconsistent`.
   */
  audio_quality_summary: string[]
  tracks: TrackProbe[]
}

export interface ArtistProbeOutput {
  artist: string
  albums: AlbumProbeOutput[]
}

// Audiobooks
export interface ChapterProbe extends FileProbe {
  disc: number
  chapter: number
}

export interface BookProbeOutput {
  title: string
  authors: string[]
  media_type: string[]
  chapters: ChapterProbe[]
}
