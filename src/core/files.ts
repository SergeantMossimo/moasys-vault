/**
 * core/files.ts
 * -------------
 * Shared helpers for classifying media files by extension and sanitizing
 * filename strings for cross-platform safety.
 * Used by every media module so extension logic lives in exactly one place.
 */

import fs from 'fs'
import path from 'path'

/** The nine printable characters Windows rejects anywhere in a filename. */
const PRINTABLE_ILLEGAL_CHARS = /[<>:"|?*\\/]/

/** Highest code point in the C0 control range; DEL sits at 127, just past it. */
const LAST_CONTROL_CODE = 31
const DEL_CODE = 127

/**
 * Strip Windows-illegal filename characters from a string without
 * replacement. Two groups go:
 *
 *   - the nine printable ones: `< > : " | ? * \ /`
 *   - every ASCII control character (0-31) plus DEL (127)
 *
 * Used in three distinct places:
 *
 *   1. TMDB validation — derive a copy-pasteable rename target when TMDB's
 *      canonical title contains chars the user can't put in a folder name
 *      (`"3:10 to Yuma"` → `"310 to Yuma"`).
 *   2. Music ID3 comparison — when a track's `AlbumArtist` tag is `AC/DC`
 *      but the folder must be `ACDC` (slash isn't legal in folder names),
 *      both forms should compare equal.
 *   3. `tools/rename-shows.ts` — building a real on-disk filename out of a
 *      TMDB episode title. That's the caller that makes the control range
 *      worth handling: Windows rejects 0-31 outright, so one stray character
 *      in upstream metadata would fail the rename and abort the whole batch,
 *      while DEL it silently accepts, which is worse — it would end up
 *      embedded in a filename nobody can see is wrong.
 *
 * Whitespace control characters (tab, newline, CR) go with the rest; callers
 * that care about readability collapse the remaining whitespace runs.
 *
 * Diacritics are left alone (they're legal in filenames); only the strict
 * Windows-illegal set is removed. No replacement character is substituted —
 * this matches how users typically name their folders in practice.
 *
 * Windows also reserves the device names CON, PRN, AUX, NUL, COM1-9 and
 * LPT1-9, but that's a whole-basename rule rather than a character rule, so
 * it isn't handled here: `findSuspiciousPathChars` reports those, and an
 * episode title only ever lands mid-filename where the rule doesn't apply.
 *
 * Written as an explicit scan rather than one regex so the control range
 * needs no `\x` escapes — those are easy to mangle and impossible to review
 * once they become literal bytes in the source.
 */
export function stripFilenameIllegalChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code !== undefined && (code <= LAST_CONTROL_CODE || code === DEL_CODE)) continue
    if (PRINTABLE_ILLEGAL_CHARS.test(ch)) continue
    out += ch
  }
  return out
}

/**
 * Return the form of a string that could actually exist on disk as a folder
 * name on Windows: illegal characters removed, leading/trailing whitespace
 * trimmed, and trailing periods stripped (Windows silently drops both).
 *
 * Used when comparing an ID3 tag against a folder name — without this,
 * tags like `P.O.D.` or `Billboard Hits U.S.A.` false-fire warn_folder_tag_mismatch
 * because the on-disk folder can never preserve the trailing period.
 */
export function toComparableFolderName(s: string): string {
  let out = stripFilenameIllegalChars(s).trim()
  while (out.length > 0 && (out.endsWith('.') || out.endsWith(' '))) {
    out = out.slice(0, -1)
  }
  return out
}

/** True if the filename's extension is in the provided list (case-insensitive). */
export function hasExtension(filename: string, extensions: string[]): boolean {
  const ext = path.extname(filename).toLowerCase()
  return extensions.some(e => e.toLowerCase() === ext)
}

/** True if the file's extension matches one of the provided primary extensions. */
export function isPrimary(filename: string, primaryExtensions: string[]): boolean {
  return hasExtension(filename, primaryExtensions)
}

/**
 * Build the "Non-X" prefix used in warning messages for non-primary files.
 * e.g. [".mp4"] -> "Non-.MP4"   [".mp4", ".mkv"] -> "Non-.MP4/.MKV"
 */
export function formatPrimaryExts(primaryExtensions: string[]): string {
  return 'Non-' + primaryExtensions.map(e => e.toUpperCase()).join('/')
}

/**
 * Check a single path component (folder or file name, no separators) for
 * characters or patterns that cause cross-platform headaches or silent
 * library fragmentation. Returns a list of human-readable issue strings,
 * empty when the name is clean.
 *
 * What it catches:
 *   - Leading or trailing whitespace — Windows silently trims trailing
 *     whitespace, but Plex on macOS/Linux preserves it, causing the same
 *     folder to be treated as two distinct artists/albums across clients.
 *   - Trailing period — Windows strips, same fragmentation risk.
 *   - Windows-illegal characters: < > : " | ? * — break copies to NTFS shares.
 *   - Windows-reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) —
 *     unusable as folder names on Windows even with a trailing extension.
 *
 * Path separators (\\, /) aren't checked here — they'd never appear inside
 * a single component returned by fs.readdir.
 */
export function findSuspiciousPathChars(name: string): string[] {
  const issues: string[] = []
  if (name.length === 0) return ['empty name']
  if (name !== name.trimStart()) issues.push('leading whitespace')
  if (name !== name.trimEnd()) issues.push('trailing whitespace')
  if (name.endsWith('.')) issues.push('trailing period (Windows-incompatible)')
  const illegal = name.match(/[<>:"|?*]/g)
  if (illegal) {
    const unique = [...new Set(illegal)].sort().join(' ')
    issues.push(`illegal characters: ${unique}`)
  }
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)) {
    issues.push('Windows-reserved name')
  }
  return issues
}

// ─────────────────────────────────────────────
// Unexpected-entry detection
// ─────────────────────────────────────────────

/**
 * Known OS/system artifacts that frequently appear in media folders but are
 * always intentional (created by the OS or sync clients, not the user).
 * Case-insensitive matching.
 *
 * Hidden dotfiles (anything starting with `.`) are handled separately via a
 * leading-dot check so we don't have to enumerate every macOS/Linux variant.
 */
const KNOWN_OS_FILES = new Set([
  'thumbs.db',
  'desktop.ini',
  'ehthumbs.db',
  'ehthumbs_vista.db',
  'icon\r', // macOS custom folder icon (literal CR at end)
  'icon.ico', // Windows custom folder icon (paired with desktop.ini)
  '$recycle.bin',
  'system volume information',
  '.directory', // KDE
  '.localized', // macOS
])

/** True if `name` is a known OS/system artifact or a hidden dotfile. */
function isOSArtifact(name: string): boolean {
  if (name.startsWith('.')) return true
  return KNOWN_OS_FILES.has(name.toLowerCase())
}

/**
 * Identify entries that don't fit any expected category at the current
 * filesystem level. An entry counts as "unexpected" when it is:
 *   - a file that doesn't match the media extensions
 *   - AND doesn't match the sidecar extensions
 *   - AND isn't a known OS artifact / hidden dotfile
 *
 * Directories are NEVER reported by this function — structural directory
 * issues are surfaced by warn_loose_files / warn_extra_subfolders instead,
 * which carry richer per-level context.
 *
 * The returned list is the raw set of unexpected `Dirent` entries; the caller
 * decides how to format the warning message (typically by listing their names).
 */
export function findUnexpectedEntries(
  entries: fs.Dirent[],
  mediaExtensions: string[],
  sidecarExtensions: string[]
): fs.Dirent[] {
  const mediaSet = new Set(mediaExtensions.map(e => e.toLowerCase()))
  const sidecarSet = new Set(sidecarExtensions.map(e => e.toLowerCase()))
  return entries.filter(e => {
    if (e.isDirectory()) return false
    if (!e.isFile()) return false // skip symlinks, devices, etc.
    if (isOSArtifact(e.name)) return false
    const ext = path.extname(e.name).toLowerCase()
    if (mediaSet.has(ext)) return false
    if (sidecarSet.has(ext)) return false
    return true
  })
}
